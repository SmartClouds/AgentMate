namespace Runova.ServerCore.ErrorReporting;

/// <summary>
/// Catches what would otherwise vanish: an exception nobody handled (the core is about to stop) and a
/// background task that failed with nobody waiting for it. Both are logged like any other error, so
/// they reach Sentry when reporting is on. The core had no global hook before this.
/// </summary>
internal sealed partial class ErrorReportingHooks(ILogger logger, ErrorReportingLogs logs)
{
    /// <summary>How long a dying core waits to hand its last words to Sentry.</summary>
    private const int FlushMilliseconds = 3_000;

    public void Attach()
    {
        AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
    }

    public void Detach()
    {
        AppDomain.CurrentDomain.UnhandledException -= OnUnhandledException;
        TaskScheduler.UnobservedTaskException -= OnUnobservedTaskException;
    }

    public void OnUnhandledException(object? sender, UnhandledExceptionEventArgs e)
    {
        ArgumentNullException.ThrowIfNull(e);
        if (e.ExceptionObject is Exception exception)
        {
            if (e.IsTerminating)
            {
                LogCrash(logger, exception);
            }
            else
            {
                LogUnhandled(logger, exception);
            }
        }
        else
        {
            var description = e.ExceptionObject?.ToString() ?? string.Empty;
            LogNotAnException(logger, description);
        }

        // The process may be gone a moment from now, so this is the last chance to send it.
        logs.Flush(FlushMilliseconds);
    }

    /// <summary>Runs on the finalizer thread, so it only logs: the batch goes out on its own within seconds.</summary>
    public void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        ArgumentNullException.ThrowIfNull(e);
        LogUnobserved(logger, e.Exception);
    }

    [LoggerMessage(Level = LogLevel.Critical, Message = "The core hit an unhandled exception and is stopping.")]
    private static partial void LogCrash(ILogger logger, Exception exception);

    [LoggerMessage(Level = LogLevel.Error, Message = "The core hit an unhandled exception.")]
    private static partial void LogUnhandled(ILogger logger, Exception exception);

    [LoggerMessage(Level = LogLevel.Critical, Message = "The core hit an unhandled error that is not an exception: {Error}")]
    private static partial void LogNotAnException(ILogger logger, string error);

    [LoggerMessage(Level = LogLevel.Error, Message = "A background task failed and nothing was waiting for its result.")]
    private static partial void LogUnobserved(ILogger logger, Exception exception);
}
