// These tests are about what the plain ILogger calls send, so they make those calls directly.
#pragma warning disable CA1848, CA2254

using System.Net;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.ErrorReporting;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.ErrorReporting;

/// <summary>
/// The manager keeps the settings file and the live pipeline in step: what is saved is what is sent
/// to, it survives a restart, and the status screen never sees the key.
/// </summary>
public sealed class ErrorReportingManagerTests : IDisposable
{
    private const string Key = "d4e5f60718293a4b5c6d7e8f90a1b2c3";

    private const string Dsn = $"https://{Key}@o1.ingest.sentry.io/42";

    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"runova-error-reporting-mgr-{Guid.NewGuid():N}");

    private readonly FakeIngest _ingest = new();

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 22, 12, 0, 0, TimeSpan.Zero));

    private readonly EphemeralDataProtectionProvider _protection = new();

    private readonly List<IDisposable> _disposables = [];

    public void Dispose()
    {
        foreach (var disposable in _disposables)
        {
            disposable.Dispose();
        }

        TestFolders.Delete(_directory);
    }

    private (ErrorReportingManager Manager, ErrorReportingLogs Logs) Create()
    {
        var logs = new ErrorReportingLogs(new FakeIngestTransport(_ingest), new Redactor(), "1.0.0", _time);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Core:DataDirectory"] = _directory })
            .Build();
        var manager = new ErrorReportingManager(configuration, logs, _protection, _time, NullLogger<ErrorReportingManager>.Instance, "build-box");
        _disposables.Add(logs);
        return (manager, logs);
    }

    private static ErrorReportingRequest Request(string? dsn = Dsn, bool enabled = true, string? environment = "staging", string? serverName = "web-1", string? level = "warning") =>
        new(dsn, enabled, environment, serverName, level);

    [Fact]
    public async Task Before_anything_is_saved_the_status_says_not_set_up_and_offers_the_machine_name()
    {
        var (manager, _) = Create();

        var status = await manager.StatusAsync(Cancel);

        Assert.False(status.Configured);
        Assert.False(status.Enabled);
        Assert.Null(status.Host);
        Assert.Equal("production", status.Environment);
        Assert.Equal("warning", status.MinLevel);
        Assert.Equal("build-box", status.DefaultServerName);
        Assert.Equal("build-box", status.ServerName);
    }

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Saving_starts_reporting_at_once_and_the_status_describes_it_without_the_key()
    {
        var (manager, logs) = Create();

        var saved = await manager.SaveAsync(Request(), "maria", Cancel);
        logs.CreateLogger("Test").LogWarning("first words");
        Assert.True(logs.Flush(10_000));

        Assert.Empty(saved.Problems);
        var status = saved.Status!;
        Assert.True(status.Configured);
        Assert.True(status.Enabled);
        Assert.Equal("o1.ingest.sentry.io", status.Host);
        Assert.Equal("42", status.ProjectId);
        Assert.Equal("staging", status.Environment);
        Assert.Equal("web-1", status.ServerName);
        Assert.Equal("maria", status.ChangedBy);
        Assert.Equal(_time.GetUtcNow().ToUnixTimeMilliseconds(), status.ChangedAtUnixMs);
        Assert.DoesNotContain(Key, status.ToString(), StringComparison.Ordinal);
        Assert.Contains("first words", _ingest.AllBodies, StringComparison.Ordinal);
    }

    [Fact]
    public async Task What_is_saved_is_picked_up_again_after_a_restart()
    {
        var (first, _) = Create();
        await first.SaveAsync(Request(level: "error"), "maria", Cancel);

        var (second, logs) = Create();
        second.Start();
        logs.CreateLogger("Test").LogWarning("held back by the level");
        logs.CreateLogger("Test").LogError("sent after the restart");
        Assert.True(logs.Flush(10_000));

        Assert.True(logs.IsReporting);
        Assert.Equal("error", (await second.StatusAsync(Cancel)).MinLevel);
        Assert.DoesNotContain("held back by the level", _ingest.AllBodies, StringComparison.Ordinal);
        Assert.Contains("sent after the restart", _ingest.AllBodies, StringComparison.Ordinal);
    }

    [Fact]
    public void Starting_never_stops_the_core_from_starting_whatever_is_wrong_with_the_settings()
    {
        var logs = new ErrorReportingLogs(new FakeIngestTransport(_ingest), new Redactor(), "1.0.0", _time);
        _disposables.Add(logs);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Core:DataDirectory"] = _directory })
            .Build();
        var manager = new ErrorReportingManager(configuration, logs, new BrokenProtection(), _time, NullLogger<ErrorReportingManager>.Instance, "build-box");

        var thrown = Record.Exception(manager.Start);

        Assert.Null(thrown);
        Assert.False(logs.IsReporting);
    }

    private sealed class BrokenProtection : IDataProtectionProvider
    {
        public IDataProtector CreateProtector(string purpose) => throw new InvalidOperationException("The key ring cannot be read.");
    }

    [Fact]
    public async Task A_paused_setup_is_kept_but_sends_nothing()
    {
        var (manager, logs) = Create();

        var saved = await manager.SaveAsync(Request(enabled: false), "maria", Cancel);
        logs.CreateLogger("Test").LogWarning("nobody hears this");
        Assert.True(logs.Flush(10_000));

        Assert.True(saved.Status!.Configured);
        Assert.False(saved.Status.Enabled);
        Assert.False(logs.IsReporting);
        Assert.Empty(_ingest.Requests);
    }

    [Fact]
    public async Task Leaving_the_dsn_out_keeps_the_stored_one_so_other_settings_can_change()
    {
        var (manager, _) = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);

        var saved = await manager.SaveAsync(Request(dsn: null, environment: "production", level: "error"), "ahmad", Cancel);

        Assert.Empty(saved.Problems);
        Assert.Equal("o1.ingest.sentry.io", saved.Status!.Host);
        Assert.Equal("42", saved.Status.ProjectId);
        Assert.Equal("production", saved.Status.Environment);
        Assert.Equal("error", saved.Status.MinLevel);
        Assert.Equal("ahmad", saved.Status.ChangedBy);
    }

    [Fact]
    public async Task Leaving_the_dsn_out_when_there_is_none_is_a_problem()
    {
        var (manager, _) = Create();

        var saved = await manager.SaveAsync(Request(dsn: null), "maria", Cancel);

        Assert.Contains(saved.Problems, problem => problem.Contains("DSN", StringComparison.Ordinal));
        Assert.Null(saved.Status);
        Assert.False((await manager.StatusAsync(Cancel)).Configured);
    }

    [Fact]
    public async Task A_bad_request_stores_nothing_and_says_everything_that_is_wrong()
    {
        var (manager, logs) = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);

        var saved = await manager.SaveAsync(Request(dsn: "http://example.com/1", environment: "no good", level: "loud"), "maria", Cancel);

        Assert.Equal(3, saved.Problems.Length);
        Assert.Null(saved.Status);
        var status = await manager.StatusAsync(Cancel);
        Assert.Equal("staging", status.Environment);
        Assert.Equal("o1.ingest.sentry.io", status.Host);
        Assert.True(logs.IsReporting);
    }

    [Fact]
    public async Task Removing_deletes_the_setup_and_stops_the_reporting()
    {
        var (manager, logs) = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);

        var status = await manager.RemoveAsync("maria", Cancel);
        logs.CreateLogger("Test").LogWarning("after removal");
        Assert.True(logs.Flush(10_000));

        Assert.False(status.Configured);
        Assert.False(logs.IsReporting);
        Assert.False((await manager.StatusAsync(Cancel)).Configured);
        Assert.DoesNotContain("after removal", _ingest.AllBodies, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_status_shows_how_delivery_is_going()
    {
        var (manager, logs) = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);
        logs.CreateLogger("Test").LogWarning("one");
        logs.CreateLogger("Test").LogError("two");
        Assert.True(logs.Flush(10_000));

        var good = await manager.StatusAsync(Cancel);
        _ingest.Respond = _ => new HttpResponseMessage(HttpStatusCode.Unauthorized);
        logs.CreateLogger("Test").LogWarning("three");
        Assert.True(logs.Flush(10_000));
        var bad = await manager.StatusAsync(Cancel);

        Assert.Equal(2, good.SentCount);
        Assert.Equal(_time.GetUtcNow().ToUnixTimeMilliseconds(), good.LastSentAtUnixMs);
        Assert.Null(good.LastError);
        Assert.Contains("rejected the key", bad.LastError, StringComparison.Ordinal);
        Assert.NotNull(bad.LastFailedAtUnixMs);
        Assert.Equal(2, bad.SentCount);
    }

    [Fact]
    public async Task A_test_event_reaches_sentry_and_the_result_says_so()
    {
        var (manager, _) = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);

        var result = await manager.SendTestAsync("maria", Cancel);

        Assert.True(result.Delivered);
        Assert.Equal(200, result.HttpStatus);
        Assert.Contains("accepted", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("test event", _ingest.AllBodies, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("web-1", _ingest.AllBodies, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_test_event_goes_through_even_when_only_errors_are_reported()
    {
        var (manager, _) = Create();
        await manager.SaveAsync(Request(level: "error"), "maria", Cancel);

        var result = await manager.SendTestAsync("maria", Cancel);

        Assert.True(result.Delivered);
    }

    [Fact]
    public async Task A_test_event_that_sentry_refuses_says_why()
    {
        var (manager, _) = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);
        _ingest.Respond = _ => new HttpResponseMessage(HttpStatusCode.Unauthorized);

        var result = await manager.SendTestAsync("maria", Cancel);

        Assert.False(result.Delivered);
        Assert.Equal(401, result.HttpStatus);
        Assert.Contains("rejected the key", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_test_event_needs_a_setup_that_is_on()
    {
        var (manager, _) = Create();

        var none = await manager.SendTestAsync("maria", Cancel);
        await manager.SaveAsync(Request(enabled: false), "maria", Cancel);
        var paused = await manager.SendTestAsync("maria", Cancel);

        Assert.False(none.Delivered);
        Assert.Contains("not set up", none.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(paused.Delivered);
        Assert.Contains("paused", paused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(_ingest.Requests);
    }

    [Fact]
    public async Task The_crash_hooks_report_an_unhandled_and_an_unobserved_exception_even_for_errors_only()
    {
        var (manager, logs) = Create();
        await manager.SaveAsync(Request(level: "error"), "maria", Cancel);
        using var factory = LoggerFactory.Create(builder => builder.AddProvider(logs));
        var hooks = new ErrorReportingHooks(factory.CreateLogger("Runova.ServerCore.Crash"), logs);

        hooks.OnUnobservedTaskException(this, new UnobservedTaskExceptionEventArgs(new AggregateException(new InvalidOperationException("a task nobody awaited"))));
        hooks.OnUnhandledException(this, new UnhandledExceptionEventArgs(new InvalidOperationException("the core is dying"), isTerminating: true));

        Assert.Contains("a task nobody awaited", _ingest.AllBodies, StringComparison.Ordinal);
        Assert.Contains("the core is dying", _ingest.AllBodies, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_thing_that_is_not_an_exception_is_still_reported_by_the_unhandled_hook()
    {
        var (manager, logs) = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);
        using var factory = LoggerFactory.Create(builder => builder.AddProvider(logs));
        var hooks = new ErrorReportingHooks(factory.CreateLogger("Runova.ServerCore.Crash"), logs);

        hooks.OnUnhandledException(this, new UnhandledExceptionEventArgs("a plain string was thrown", isTerminating: false));

        Assert.Contains("a plain string was thrown", _ingest.AllBodies, StringComparison.Ordinal);
    }
}
