using System.Diagnostics;
using System.Net;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry.Trace;
using Runova.Website.IntegrationTests.Infrastructure;
using Sentry;
using Sentry.AspNetCore;

namespace Runova.Website.IntegrationTests.Telemetry;

[Collection(TelemetryTestGroup.Name)]
public sealed class TelemetryTests(PostgresFixture postgres)
{
    private const string CsrfTokens = "/api/v1/csrf-tokens/current";

    [Fact]
    public async Task An_unhandled_exception_reaches_Sentry_with_the_trace_id_and_no_secret_header()
    {
        var transport = new FakeSentryTransport();
        using var factory = new WebsiteApiFactory(
            postgres.ConnectionString,
            settings: new Dictionary<string, string> { ["Sentry:Dsn"] = FakeSentryTransport.Dsn },
            services: services =>
            {
                services.Configure<SentryAspNetCoreOptions>(options => options.Transport = transport);
                services.AddSingleton<IAntiforgery, ThrowingAntiforgery>();
            });
        var secrets = new Dictionary<string, string>
        {
            ["Cookie"] = "__Host-runova-session=cookie-secret-1; XSRF-TOKEN=cookie-secret-2",
            ["Authorization"] = "Bearer authorization-secret-3",
            ["X-Runova-Key-Id"] = "key-id-secret-4",
            ["X-Runova-Signature"] = "signature-secret-5",
            ["x-runova-nonce"] = "nonce-secret-6",
        };
        using var request = new HttpRequestMessage(HttpMethod.Get, CsrfTokens);
        foreach (var (name, value) in secrets)
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        var response = await factory.CreateApiClient().Http.SendAsync(request, TestContext.Current.CancellationToken);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.InternalServerError, ProblemAssert.Type("internal"), CsrfTokens);
        var traceId = problem.GetProperty("traceId").GetString()!.Split('-')[1];
        await SentrySdk.FlushAsync(TimeSpan.FromSeconds(5));
        var events = transport.Events
            .Where(e => e.TryGetProperty("exception", out var exception) && exception.ToString().Contains(ThrowingAntiforgery.Message, StringComparison.Ordinal))
            .ToList();
        Assert.NotEmpty(events);
        Assert.All(events, e => Assert.Equal(traceId, e.GetProperty("contexts").GetProperty("trace").GetProperty("trace_id").GetString()));
        var sent = string.Concat(transport.Envelopes);
        Assert.Contains(CsrfTokens, sent, StringComparison.Ordinal);
        foreach (var secret in secrets.Values.SelectMany(v => v.Split(' ', ';', '=')).Where(v => v.Contains("secret", StringComparison.Ordinal)))
        {
            Assert.DoesNotContain(secret, sent, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_request_produces_an_AspNetCore_span_with_an_EF_Core_child_span()
    {
        var spans = new ExportedSpans();
        using var factory = new WebsiteApiFactory(
            postgres.ConnectionString,
            services: services => services.ConfigureOpenTelemetryTracerProvider(tracing => tracing.AddInMemoryExporter(spans)));
        var traceId = ActivityTraceId.CreateRandom();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health/ready");
        request.Headers.Add("traceparent", $"00-{traceId}-{ActivitySpanId.CreateRandom()}-01");

        var response = await factory.CreateApiClient().Http.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var trace = (await spans.WaitForAsync(s => s.TraceId == traceId && s.Source.Name == "Microsoft.AspNetCore"))
            .Where(s => s.TraceId == traceId)
            .ToList();
        var requestSpan = Assert.Single(trace, s => s.Source.Name == "Microsoft.AspNetCore");
        Assert.Equal(ActivityKind.Server, requestSpan.Kind);
        var query = Assert.Single(trace, s => s.Source.Name == "OpenTelemetry.Instrumentation.EntityFrameworkCore");
        Assert.Equal(requestSpan.SpanId, query.ParentSpanId);
        Assert.Contains(trace, s => s.Source.Name == "Npgsql");

        // The readiness check runs SELECT 1. A summary such as "SELECT" may stay; the text may not.
        Assert.All(trace, span => Assert.All(span.TagObjects, tag => Assert.DoesNotContain("SELECT 1", tag.Value?.ToString() ?? "", StringComparison.Ordinal)));
        Assert.All(trace, span => Assert.DoesNotContain("SELECT 1", span.DisplayName, StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_API_serves_requests_with_no_Sentry_DSN_and_no_OTLP_endpoint()
    {
        using var factory = new WebsiteApiFactory(
            postgres.ConnectionString,
            settings: new Dictionary<string, string> { ["Sentry:Dsn"] = "", ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "" });
        var client = factory.CreateApiClient();

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/ready")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(CsrfTokens)).StatusCode);
        Assert.False(SentrySdk.IsEnabled);
        Assert.NotNull(factory.Services.GetService<TracerProvider>());
    }

    private sealed class ThrowingAntiforgery : IAntiforgery
    {
        public const string Message = "The antiforgery store broke for the Sentry test.";

        public AntiforgeryTokenSet GetAndStoreTokens(HttpContext httpContext) => throw new InvalidOperationException(Message);

        public AntiforgeryTokenSet GetTokens(HttpContext httpContext) => throw new InvalidOperationException(Message);

        public Task<bool> IsRequestValidAsync(HttpContext httpContext) => throw new InvalidOperationException(Message);

        public Task ValidateRequestAsync(HttpContext httpContext) => throw new InvalidOperationException(Message);

        public void SetCookieTokenAndHeader(HttpContext httpContext) => throw new InvalidOperationException(Message);
    }
}
