using HangfireLevel = Hangfire.Logging.LogLevel;

namespace AgentMate.ServerCore.Backups;

/// <summary>
/// Hangfire's logs into the core's own. Hangfire keeps its log provider, and the loggers its classes
/// take from it, in statics for the whole process; the provider AddHangfire installs holds the
/// first host's logger factory for good. Every logger here asks for the factory the newest host
/// installed instead, and drops a line when that host is gone: in production there is one host,
/// but the tests start and stop many in one process.
/// </summary>
internal sealed class HangfireLogs : Hangfire.Logging.ILogProvider
{
    private static ILoggerFactory? _current;

    public HangfireLogs(ILoggerFactory factory) => Volatile.Write(ref _current, factory);

    public Hangfire.Logging.ILog GetLogger(string name) => new Bridge(name);

    private sealed class Bridge(string name) : Hangfire.Logging.ILog
    {
        public bool Log(HangfireLevel logLevel, Func<string>? messageFunc, Exception? exception = null)
        {
            ILogger logger;
            try
            {
                if (Volatile.Read(ref _current) is not { } factory)
                {
                    return false;
                }

                logger = factory.CreateLogger(name);
            }
            catch (ObjectDisposedException)
            {
                return false;
            }

            var level = logLevel switch
            {
                HangfireLevel.Trace => LogLevel.Trace,
                HangfireLevel.Debug => LogLevel.Debug,
                HangfireLevel.Info => LogLevel.Information,
                HangfireLevel.Warn => LogLevel.Warning,
                HangfireLevel.Error => LogLevel.Error,
                _ => LogLevel.Critical,
            };
            if (messageFunc is null)
            {
                return logger.IsEnabled(level);
            }

            if (logger.IsEnabled(level))
            {
#pragma warning disable CA1848, CA2254 // Hangfire hands over finished text, not a template.
                logger.Log(level, exception, messageFunc());
#pragma warning restore CA1848, CA2254
            }

            return true;
        }
    }
}
