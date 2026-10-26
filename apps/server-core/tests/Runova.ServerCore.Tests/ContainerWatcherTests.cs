using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The container watcher follows Docker's events in the background and turns a crash loop into an
/// alert, whether or not anyone has the app open. It waits for Docker when Docker is not there yet,
/// and clears the alert once the container has been quiet for a while.
/// </summary>
public sealed class ContainerWatcherTests : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));

    private TestDatabase _database = null!;

    private AlertCenter _alerts = null!;

    private InMemoryDockerEngine _engine = null!;

    private ContainerWatcher? _watcher;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        _engine = new InMemoryDockerEngine(_clock);
    }

    public async ValueTask DisposeAsync()
    {
        if (_watcher is not null)
        {
            await _watcher.StopAsync(CancellationToken.None);
            _watcher.Dispose();
        }

        _alerts.Dispose();
        await _database.DisposeAsync();
    }

    private async Task StartAsync()
    {
        _watcher = new ContainerWatcher(_engine, _alerts, _clock, ContainerWatchOptions.Default, NullLogger<ContainerWatcher>.Instance);
        await _watcher.StartAsync(Cancel);
    }

    private void CrashThreeTimes()
    {
        for (var i = 0; i < 3; i++)
        {
            _clock.Advance(TimeSpan.FromSeconds(5));
            _engine.SimulateCrash("shop-api-1", exitCode: 1);
        }
    }

    private async Task<AlertInfo[]> WaitForOpenAsync(int count)
    {
        AlertInfo[] open = [];
        for (var i = 0; i < 500; i++)
        {
            open = await _alerts.OpenAsync(AlertKind.ContainerCrashLoop, Cancel);
            if (open.Length == count)
            {
                return open;
            }

            await Task.Delay(10, Cancel);
        }

        Assert.Equal(count, open.Length);
        return open;
    }

    [Fact]
    public async Task A_container_that_keeps_crashing_raises_a_critical_alert_named_after_it()
    {
        await StartAsync();

        CrashThreeTimes();

        var alert = Assert.Single(await WaitForOpenAsync(1));
        Assert.Equal("shop-api-1", alert.Resource);
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Contains("exited 3 times", alert.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Stopping_containers_by_hand_raises_nothing()
    {
        await StartAsync();

        for (var i = 0; i < 4; i++)
        {
            _clock.Advance(TimeSpan.FromSeconds(5));
            await _engine.KillContainerAsync("shop-api-1", "SIGKILL", Cancel);
            await _engine.StartContainerAsync("shop-api-1", Cancel);
        }

        await Task.Delay(200, Cancel);
        Assert.Empty(await _alerts.OpenAsync(AlertKind.ContainerCrashLoop, Cancel));

        // Its own crashes still count, and only those.
        CrashThreeTimes();
        Assert.Contains("exited 3 times", Assert.Single(await WaitForOpenAsync(1)).Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_alert_clears_once_the_container_has_been_quiet()
    {
        await StartAsync();
        CrashThreeTimes();
        await WaitForOpenAsync(1);

        for (var i = 0; i < 12 && (await _alerts.OpenAsync(AlertKind.ContainerCrashLoop, Cancel)).Length > 0; i++)
        {
            _clock.Advance(TimeSpan.FromMinutes(1));
            await Task.Delay(50, Cancel);
        }

        await WaitForOpenAsync(0);
    }

    [Fact]
    public async Task Without_docker_it_waits_and_starts_watching_once_docker_is_there()
    {
        _engine.Running = false;
        await StartAsync();
        await Task.Delay(50, Cancel);

        _engine.Running = true;
        for (var i = 0; i < 100 && _engine.EventListeners == 0; i++)
        {
            _clock.Advance(TimeSpan.FromSeconds(10));
            await Task.Delay(20, Cancel);
        }

        CrashThreeTimes();
        await WaitForOpenAsync(1);
    }

    [Fact]
    public async Task A_loop_left_open_from_before_a_restart_is_cleared_when_it_stays_quiet()
    {
        await _alerts.RaiseAsync(AlertKind.ContainerCrashLoop, "shop-db-1", AlertSeverity.Critical, "shop-db-1 keeps restarting", Cancel);
        await StartAsync();
        await Task.Delay(50, Cancel);

        for (var i = 0; i < 12 && (await _alerts.OpenAsync(AlertKind.ContainerCrashLoop, Cancel)).Length > 0; i++)
        {
            _clock.Advance(TimeSpan.FromMinutes(1));
            await Task.Delay(50, Cancel);
        }

        await WaitForOpenAsync(0);
    }
}
