// These tests are about what the plain ILogger calls send, so they make those calls directly.
#pragma warning disable CA1848, CA2254

using System.Net;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.ErrorReporting;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.ErrorReporting;

/// <summary>
/// The logging half of error reporting, driven through the real OpenTelemetry SDK and OTLP exporter
/// with a fake Sentry in place of the network: what is sent, what is held back, what is scrubbed,
/// and that a Sentry that is down or says no never reaches the code that logged.
/// </summary>
public sealed class ErrorReportingLogsTests : IDisposable
{
    private const string Key = "d4e5f60718293a4b5c6d7e8f90a1b2c3";

    private readonly FakeIngest _ingest = new();

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 22, 12, 0, 0, TimeSpan.Zero));

    private readonly ErrorReportingLogs _logs;

    public ErrorReportingLogsTests()
    {
        _logs = new ErrorReportingLogs(new FakeIngestTransport(_ingest), new Redactor(), "9.8.7", _time);
    }

    public void Dispose() => _logs.Dispose();

    private ILogger Logger => _logs.CreateLogger("Test.Category");

    private static ErrorReportingConfig Config(
        bool enabled = true,
        ReportingLevel level = ReportingLevel.Warning,
        string environment = "staging",
        string serverName = "web-1",
        string dsn = $"https://{Key}@o1.ingest.sentry.io/42")
    {
        Assert.True(SentryDsn.TryParse(dsn, out var parsed, out var error), error);
        return new ErrorReportingConfig(enabled, parsed!, environment, serverName, level);
    }

    private string Sent()
    {
        Assert.True(_logs.Flush(10_000));
        return string.Concat(_ingest.Requests.Select(r => r.Body));
    }

    [Fact]
    public void A_warning_is_sent_and_an_information_line_is_not()
    {
        _logs.Apply(Config());

        Logger.LogInformation("chatty progress line");
        Logger.LogWarning("disk almost full on /var");

        var sent = Sent();

        Assert.Contains("disk almost full on /var", sent, StringComparison.Ordinal);
        Assert.DoesNotContain("chatty progress line", sent, StringComparison.Ordinal);
        Assert.Single(_ingest.Requests);
    }

    [Fact]
    public void Errors_only_holds_warnings_back_and_the_level_changes_without_a_restart()
    {
        _logs.Apply(Config(level: ReportingLevel.Error));
        Logger.LogWarning("just a warning");
        Logger.LogError("a real error");
        Logger.LogCritical("the core is going down");
        var first = Sent();

        _logs.Apply(Config(level: ReportingLevel.Warning));
        Logger.LogWarning("a warning that now counts");
        var second = Sent();

        Assert.DoesNotContain("just a warning", first, StringComparison.Ordinal);
        Assert.Contains("a real error", first, StringComparison.Ordinal);
        Assert.Contains("the core is going down", first, StringComparison.Ordinal);
        Assert.Contains("a warning that now counts", second, StringComparison.Ordinal);
    }

    [Fact]
    public void The_request_goes_to_the_projects_otlp_address_signed_with_the_public_key()
    {
        _logs.Apply(Config());
        Logger.LogWarning("hello");
        _ = Sent();

        var request = Assert.Single(_ingest.Requests);

        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://o1.ingest.sentry.io/api/42/integration/otlp/v1/logs", request.Uri.AbsoluteUri);
        Assert.Equal($"sentry sentry_key={Key}", request.Header("x-sentry-auth"));
        Assert.Equal("application/x-protobuf", request.ContentType);
    }

    [Fact]
    public void The_records_say_which_service_environment_and_server_they_come_from()
    {
        _logs.Apply(Config(environment: "staging", serverName: "web-1"));
        Logger.LogWarning("hello");

        var sent = Sent();

        Assert.Contains("service.name", sent, StringComparison.Ordinal);
        Assert.Contains("runova-core", sent, StringComparison.Ordinal);
        Assert.Contains("9.8.7", sent, StringComparison.Ordinal);
        Assert.Contains("deployment.environment.name", sent, StringComparison.Ordinal);
        Assert.Contains("staging", sent, StringComparison.Ordinal);
        Assert.Contains("host.name", sent, StringComparison.Ordinal);
        Assert.Contains("web-1", sent, StringComparison.Ordinal);
        Assert.Contains("Test.Category", sent, StringComparison.Ordinal);
    }

    [Fact]
    public void Structured_values_travel_as_attributes()
    {
        _logs.Apply(Config());
        Logger.LogWarning("Certificate for {Domain} expires in {Days} days", "example.com", 3);

        var sent = Sent();

        Assert.Contains("Domain", sent, StringComparison.Ordinal);
        Assert.Contains("example.com", sent, StringComparison.Ordinal);
        Assert.Contains("Certificate for example.com expires in 3 days", sent, StringComparison.Ordinal);
    }

    [Fact]
    public void An_exception_is_sent_with_its_type_message_and_stack()
    {
        _logs.Apply(Config());
        try
        {
            throw new InvalidOperationException("the volume is gone");
        }
        catch (InvalidOperationException problem)
        {
            Logger.LogError(problem, "Backup failed");
        }

        var sent = Sent();

        Assert.Contains("Backup failed", sent, StringComparison.Ordinal);
        Assert.Contains("exception.type", sent, StringComparison.Ordinal);
        Assert.Contains("System.InvalidOperationException", sent, StringComparison.Ordinal);
        Assert.Contains("the volume is gone", sent, StringComparison.Ordinal);
        Assert.Contains("exception.stacktrace", sent, StringComparison.Ordinal);
        Assert.Contains(nameof(An_exception_is_sent_with_its_type_message_and_stack), sent, StringComparison.Ordinal);
    }

    [Fact]
    public void Secrets_are_scrubbed_from_the_message_the_attributes_and_the_exception()
    {
        _logs.Apply(Config());
        Logger.LogWarning("Pull failed: docker login --password hunter2hunter2 for registry");
        Logger.LogWarning("Sign-in refused for {User} with {Password}", "bob", "attr-secret-value");
        Logger.LogWarning("Upstream said Authorization: Bearer abcdef0123456789abcdef");
        try
        {
            throw new InvalidOperationException("request failed, token=exception-secret-token");
        }
        catch (InvalidOperationException problem)
        {
            Logger.LogError(problem, "Call failed");
        }

        var sent = Sent();

        Assert.DoesNotContain("hunter2hunter2", sent, StringComparison.Ordinal);
        Assert.DoesNotContain("attr-secret-value", sent, StringComparison.Ordinal);
        Assert.DoesNotContain("abcdef0123456789abcdef", sent, StringComparison.Ordinal);
        Assert.DoesNotContain("exception-secret-token", sent, StringComparison.Ordinal);
        Assert.Contains(Redactor.Mask, sent, StringComparison.Ordinal);
        Assert.Contains("bob", sent, StringComparison.Ordinal);
    }

    [Fact]
    public void Nothing_is_sent_until_reporting_is_set_up_and_after_it_is_removed_or_paused()
    {
        Logger.LogWarning("before setup");
        _logs.Apply(Config());
        Logger.LogWarning("while on");
        var on = Sent();

        _logs.Apply(Config(enabled: false));
        Logger.LogWarning("while paused");
        _logs.Apply(null);
        Logger.LogWarning("after removal");
        var after = Sent();

        Assert.DoesNotContain("before setup", on, StringComparison.Ordinal);
        Assert.Contains("while on", on, StringComparison.Ordinal);
        Assert.DoesNotContain("while paused", after, StringComparison.Ordinal);
        Assert.DoesNotContain("after removal", after, StringComparison.Ordinal);
        Assert.False(_logs.IsReporting);
    }

    [Fact]
    public void A_logger_made_before_the_setup_starts_sending_once_it_is_applied()
    {
        var early = _logs.CreateLogger("Early.Logger");

        _logs.Apply(Config());
        early.LogWarning("from an old logger");

        Assert.Contains("from an old logger", Sent(), StringComparison.Ordinal);
    }

    [Fact]
    public void Changing_the_dsn_moves_the_logs_to_the_new_project()
    {
        _logs.Apply(Config(dsn: $"https://{Key}@o1.ingest.sentry.io/1"));
        Logger.LogWarning("one");
        _ = Sent();
        _logs.Apply(Config(dsn: $"https://{Key}@o2.ingest.de.sentry.io/2"));
        Logger.LogWarning("two");
        _ = Sent();

        Assert.Equal(
            ["https://o1.ingest.sentry.io/api/1/integration/otlp/v1/logs", "https://o2.ingest.de.sentry.io/api/2/integration/otlp/v1/logs"],
            _ingest.Requests.Select(r => r.Uri.AbsoluteUri));
    }

    [Theory]
    [InlineData("OpenTelemetry.Exporter.OpenTelemetryProtocol")]
    [InlineData("System.Net.Http.HttpClient.otlp.LogicalHandler")]
    public void The_exporters_own_logs_are_never_exported_so_a_failing_sentry_cannot_feed_itself(string category)
    {
        _logs.Apply(Config());

        _logs.CreateLogger(category).LogWarning("exporter noise");

        Assert.DoesNotContain("exporter noise", Sent(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_failing_sentry_does_not_cause_more_traffic_than_the_logs_that_were_sent()
    {
        _ingest.Respond = _ => new HttpResponseMessage(HttpStatusCode.InternalServerError);
        _logs.Apply(Config());

        Logger.LogWarning("one line");
        _ = Sent();
        Assert.True(_logs.Flush(10_000));
        Assert.True(_logs.Flush(10_000));

        Assert.Single(_ingest.Requests);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, "rejected the key")]
    [InlineData(HttpStatusCode.Forbidden, "rejected the key")]
    [InlineData(HttpStatusCode.NotFound, "no project")]
    [InlineData(HttpStatusCode.TooManyRequests, "too many")]
    [InlineData(HttpStatusCode.InternalServerError, "500")]
    [InlineData(HttpStatusCode.Found, "redirect")]
    public void A_refusal_is_remembered_in_words_and_never_reaches_the_caller(HttpStatusCode status, string expected)
    {
        _ingest.Respond = _ => new HttpResponseMessage(status);
        _logs.Apply(Config());

        var thrown = Record.Exception(() => Logger.LogWarning("unlucky"));
        _ = Sent();
        var delivery = _logs.Delivery;

        Assert.Null(thrown);
        Assert.Contains(expected, delivery.LastError, StringComparison.OrdinalIgnoreCase);
        Assert.Equal((int)status, delivery.LastStatus);
        Assert.NotNull(delivery.LastFailedAt);
        Assert.Null(delivery.LastSentAt);
        Assert.Equal(0, delivery.SentCount);
    }

    [Fact]
    public void A_sentry_that_cannot_be_reached_is_remembered_and_never_reaches_the_caller()
    {
        _ingest.Respond = _ => throw new HttpRequestException("No such host is known.");
        _logs.Apply(Config());

        var thrown = Record.Exception(() => Logger.LogWarning("unlucky"));
        _ = Sent();

        Assert.Null(thrown);
        Assert.Contains("reach", _logs.Delivery.LastError, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("o1.ingest.sentry.io", _logs.Delivery.LastError, StringComparison.Ordinal);
        Assert.Null(_logs.Delivery.LastStatus);
    }

    [Fact]
    public void Delivered_records_are_counted_and_the_time_is_kept()
    {
        _logs.Apply(Config());
        Logger.LogWarning("one");
        Logger.LogError("two");
        Logger.LogInformation("not counted");

        _ = Sent();
        var delivery = _logs.Delivery;

        Assert.Equal(2, delivery.SentCount);
        Assert.Equal(_time.GetUtcNow().ToUnixTimeMilliseconds(), delivery.LastSentAt);
        Assert.Null(delivery.LastError);
        Assert.Null(delivery.LastFailedAt);
        Assert.Equal(200, delivery.LastStatus);
    }

    [Fact]
    public void A_new_setup_starts_the_delivery_record_afresh()
    {
        _ingest.Respond = _ => new HttpResponseMessage(HttpStatusCode.Unauthorized);
        _logs.Apply(Config());
        Logger.LogWarning("unlucky");
        _ = Sent();
        Assert.NotNull(_logs.Delivery.LastError);

        _logs.Apply(Config());

        Assert.Null(_logs.Delivery.LastError);
        Assert.Equal(0, _logs.Delivery.SentCount);
    }

    [Fact]
    public void Disposing_sends_what_is_still_waiting()
    {
        _logs.Apply(Config());
        Logger.LogWarning("last words");

        _logs.Dispose();

        Assert.Contains("last words", string.Concat(_ingest.Requests.Select(r => r.Body)), StringComparison.Ordinal);
    }

    [Fact]
    public void The_scopes_and_state_of_a_log_call_are_not_needed_to_send_it()
    {
        _logs.Apply(Config());

        using (Logger.BeginScope("a scope"))
        {
            Logger.LogWarning(new EventId(7, "Named"), "inside a scope");
        }

        Assert.Contains("inside a scope", Sent(), StringComparison.Ordinal);
    }
}
