using System.Diagnostics;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Runova.Website.Api.Telemetry;

internal static class TelemetrySetup
{
    public const string DefaultServiceName = "runova-website-api";

    /// <summary>
    /// Sentry from <c>Sentry__Dsn</c>, <c>Sentry__Environment</c> and <c>Sentry__Release</c>, and
    /// OpenTelemetry traces, metrics and logs. With no DSN Sentry is off; with no
    /// <c>OTEL_EXPORTER_OTLP_ENDPOINT</c> nothing is exported. Neither stops the API.
    /// </summary>
    public static WebApplicationBuilder AddWebsiteTelemetry(this WebApplicationBuilder builder)
    {
        builder.WebHost.UseSentry(options =>
        {
            // Sentry throws on a missing DSN; an empty one turns it off.
            options.Dsn ??= string.Empty;
            options.SendDefaultPii = false;
            options.MaxRequestBodySize = Sentry.Extensibility.RequestSize.None;
            // Events take their trace id from the current activity. Traces go to the OTLP endpoint,
            // not to Sentry.
            options.UseOtlp();
            options.SetBeforeSend(SentryScrubbing.Scrub);
            options.SetBeforeBreadcrumb(SentryScrubbing.Scrub);
        });

        var configuration = builder.Configuration;
        var serviceName = configuration["OTEL_SERVICE_NAME"] is { Length: > 0 } name ? name : DefaultServiceName;
        var telemetry = builder.Services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(serviceName))
            .WithTracing(tracing => tracing
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddEntityFrameworkCoreInstrumentation()
                .AddNpgsql()
                .AddProcessor(new DropSqlText()))
            .WithMetrics(metrics => metrics
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddNpgsqlInstrumentation())
            .WithLogging();

        if (!string.IsNullOrWhiteSpace(configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
        {
            telemetry.UseOtlpExporter();
        }

        return builder;
    }

    /// <summary>
    /// Takes the SQL text off database spans before any exporter sees them: a statement can hold
    /// literal values. Registered ahead of the exporters, so it runs first.
    /// </summary>
    private sealed class DropSqlText : BaseProcessor<Activity>
    {
        public override void OnEnd(Activity data)
        {
            data.SetTag("db.statement", null);
            data.SetTag("db.query.text", null);
        }
    }
}
