using System.Globalization;
using Microsoft.AspNetCore.DataProtection;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.ErrorReporting;

/// <summary>
/// Keeps the settings file and the live pipeline in step. What is saved is what is sent to, it is
/// picked up again after a restart, and the key stays inside: the status only ever says where logs go.
/// </summary>
internal sealed partial class ErrorReportingManager(
    IConfiguration configuration,
    ErrorReportingLogs logs,
    IDataProtectionProvider protection,
    TimeProvider time,
    ILogger<ErrorReportingManager> logger,
    string? machineName = null) : IDisposable
{
    private const string SettingsFile = "error-reporting.json";

    private const int TestFlushMilliseconds = 15_000;

    /// <summary>Not under the namespace the pipeline never forwards, so the test event goes out.</summary>
    private const string TestCategory = "Runova.ErrorReporting.Test";

    private readonly SemaphoreSlim _gate = new(1, 1);

    private string MachineName => machineName ?? Environment.MachineName;

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    private ErrorReportingStore Store => new(
        Path.Combine(CorePaths.DataDirectory(configuration, OperatingSystem.IsLinux()), SettingsFile),
        protection.CreateProtector(FrozenIdentifiers.ErrorReportingDsnPurpose));

    public void Dispose() => _gate.Dispose();

    /// <summary>
    /// Starts sending when the settings were left on. Called once, as the core starts. Reporting is
    /// a courtesy: whatever is wrong with its settings or the key ring, the core still starts.
    /// </summary>
    public void Start()
    {
        try
        {
            var config = Store.Read();
            logs.Apply(config);
            if (config is { Enabled: true, Dsn: var dsn })
            {
                var host = dsn.Authority;
                LogStarted(logger, host, dsn.ProjectId);
            }
        }
#pragma warning disable CA1031 // Nothing here may stop the core from starting.
        catch (Exception problem)
#pragma warning restore CA1031
        {
            LogStartFailed(logger, problem);
        }
    }

    public async Task<ErrorReportingStatus> StatusAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return Describe(Store.Read());
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ErrorReportingSaveResult> SaveAsync(ErrorReportingRequest? request, string changedBy, CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return new ErrorReportingSaveResult(["There was nothing to save."]);
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var store = Store;
            var current = store.Read();
            var problems = new List<string>();

            SentryDsn? dsn = null;
            if (string.IsNullOrWhiteSpace(request.Dsn))
            {
                if (current is null)
                {
                    problems.Add("Paste the DSN from your Sentry project (Project settings, then Client Keys).");
                }
                else
                {
                    dsn = current.Dsn;
                }
            }
            else if (!SentryDsn.TryParse(request.Dsn, out dsn, out var dsnProblem))
            {
                problems.Add(dsnProblem);
            }

            problems.AddRange(ErrorReportingConfig.Check(
                request.Environment,
                request.ServerName,
                request.MinLevel,
                MachineName,
                out var environment,
                out var serverName,
                out var level));
            if (problems.Count > 0 || dsn is null)
            {
                return new ErrorReportingSaveResult([.. problems]);
            }

            var config = new ErrorReportingConfig(request.Enabled, dsn, environment, serverName, level, Now, changedBy);
            store.Write(config);
            logs.Apply(config);
            return new ErrorReportingSaveResult([], Describe(config));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ErrorReportingStatus> RemoveAsync(string changedBy, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            Store.Delete();
            logs.Apply(null);
            LogRemoved(logger, changedBy);
            return Describe(null);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Sends one event to the project and waits for Sentry's answer. It is logged at the lowest level the
    /// setup lets through, so a test works whichever level is chosen.
    /// </summary>
    public async Task<ErrorReportingTestResult> SendTestAsync(string requestedBy, CancellationToken cancellationToken)
    {
        ErrorReportingConfig? config;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            config = Store.Read();
        }
        finally
        {
            _gate.Release();
        }

        if (config is null)
        {
            return new ErrorReportingTestResult(false, null, "Error reporting is not set up on this server yet.");
        }

        if (!config.Enabled)
        {
            return new ErrorReportingTestResult(false, null, "Error reporting is paused. Turn it on, then send the test again.");
        }

        var before = logs.Delivery;
        var testLogger = logs.CreateLogger(TestCategory);
        var testLevel = config.MinLevel == ReportingLevel.Error ? LogLevel.Error : LogLevel.Warning;
        LogTest(testLogger, testLevel, config.ServerName, requestedBy);
        var answered = await Task.Run(() => logs.Flush(TestFlushMilliseconds), cancellationToken);
        var after = logs.Delivery;

        if (after.SentCount > before.SentCount)
        {
            var status = after.LastStatus is int code ? $" (HTTP {code.ToString(CultureInfo.InvariantCulture)})" : string.Empty;
            return new ErrorReportingTestResult(true, after.LastStatus, $"Sentry accepted the test event{status}. It should show up in the project's Logs within a minute.");
        }

        return new ErrorReportingTestResult(
            false,
            after.LastStatus,
            after.LastError ?? (answered ? "Sentry did not confirm the test event." : "Sentry did not answer in time."));
    }

    private ErrorReportingStatus Describe(ErrorReportingConfig? config)
    {
        if (config is null)
        {
            return new ErrorReportingStatus(
                Configured: false,
                Enabled: false,
                Host: null,
                ProjectId: null,
                Environment: ErrorReportingConfig.DefaultEnvironment,
                ServerName: MachineName,
                MinLevel: ReportingLevel.Warning.ToWire(),
                DefaultServerName: MachineName,
                SentCount: 0);
        }

        var delivery = config.Enabled ? logs.Delivery : ErrorDelivery.None;
        return new ErrorReportingStatus(
            Configured: true,
            Enabled: config.Enabled,
            Host: config.Dsn.Authority,
            ProjectId: config.Dsn.ProjectId,
            Environment: config.Environment,
            ServerName: config.ServerName,
            MinLevel: config.MinLevel.ToWire(),
            DefaultServerName: MachineName,
            SentCount: delivery.SentCount,
            LastSentAtUnixMs: delivery.LastSentAt,
            LastFailedAtUnixMs: delivery.LastFailedAt,
            LastError: delivery.LastError,
            ChangedAtUnixMs: config.ChangedAt,
            ChangedBy: config.ChangedBy);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Error reporting is on: logs go to {Host}, project {ProjectId}.")]
    private static partial void LogStarted(ILogger logger, string host, string projectId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Error reporting could not be started, so it is off until it is set up again.")]
    private static partial void LogStartFailed(ILogger logger, Exception exception);

    [LoggerMessage(Level = LogLevel.Information, Message = "Error reporting was removed by {User}.")]
    private static partial void LogRemoved(ILogger logger, string user);

    [LoggerMessage(Message = "Runova test event from {Server}, requested by {User}. If you can read this in Sentry, error reporting works.")]
    private static partial void LogTest(ILogger logger, LogLevel level, string server, string user);
}
