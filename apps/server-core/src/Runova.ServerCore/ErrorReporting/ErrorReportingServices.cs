using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Runova.ServerCore.ErrorReporting;

/// <summary>Turns reporting on when the core starts if the settings were left on, and watches for crashes.</summary>
internal sealed class ErrorReportingStartup(ErrorReportingManager manager, ErrorReportingLogs logs, ILoggerFactory loggers) : IHostedService
{
    private ErrorReportingHooks? _hooks;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        manager.Start();
        _hooks = new ErrorReportingHooks(loggers.CreateLogger("Runova.ServerCore.Crash"), logs);
        _hooks.Attach();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _hooks?.Detach();
        logs.Flush(3_000);
        return Task.CompletedTask;
    }
}

internal static class ErrorReportingServices
{
    /// <summary>
    /// Adds error reporting: a logger provider next to the console that forwards warnings and errors to
    /// Sentry once a person sets it up. Nothing is sent, and nothing leaves the machine, until then.
    /// </summary>
    public static WebApplicationBuilder AddErrorReporting(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.Services.TryAddSingleton<IErrorReportingTransport, SocketsErrorReportingTransport>();
        builder.Services.TryAddSingleton<Security.Redactor>();
        builder.Services.AddSingleton(provider => new ErrorReportingLogs(
            provider.GetRequiredService<IErrorReportingTransport>(),
            provider.GetRequiredService<Security.Redactor>(),
            CoreVersion.Current,
            provider.GetRequiredService<TimeProvider>()));
        builder.Services.AddSingleton<ILoggerProvider>(provider => provider.GetRequiredService<ErrorReportingLogs>());
        builder.Services.AddSingleton<ErrorReportingManager>();
        builder.Services.AddHostedService<ErrorReportingStartup>();
        return builder;
    }
}
