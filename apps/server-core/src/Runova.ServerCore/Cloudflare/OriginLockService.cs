using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Updates;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Cloudflare;

/// <param name="RefreshInterval">How often Cloudflare's ranges are fetched again.</param>
/// <param name="FirstRefreshAfter">The first fetch after the core starts, so a restart loop never hammers Cloudflare.</param>
internal sealed record OriginLockOptions(TimeSpan RefreshInterval, TimeSpan FirstRefreshAfter, bool RunInBackground = true)
{
    public static OriginLockOptions Default { get; } = new(TimeSpan.FromDays(1), TimeSpan.FromMinutes(5));

    /// <summary>Ranges fetched longer ago than this are fetched again before a person turns the lock on.</summary>
    public TimeSpan FreshFor => RefreshInterval;
}

/// <summary>
/// The Cloudflare-only origin lock (E14 T6). Turning it on or off is a firewall change set like
/// any other (checked by the lockout guard, rolled back unless confirmed over a new SSH
/// connection), plus an nginx apply that restores the visitor's address and, when asked, checks
/// Cloudflare's client certificate. Once a day the ranges are fetched again; when they changed and
/// the lock is on, the firewall is brought up to date by the core itself (only allow rules on 80
/// and 443, which cannot touch SSH) and nginx with it. Anything that goes wrong raises an alert.
/// </summary>
internal sealed partial class OriginLockService(
    IDbContextFactory<CoreDbContext> contexts,
    ICloudflareRangeSource source,
    FirewallManager firewall,
    IFirewallBackendSource backends,
    WebSites sites,
    AlertCenter alerts,
    OriginLockOptions options,
    TimeProvider time,
    ILogger<OriginLockService> logger) : BackgroundService
{
    public const string AlertResource = "cloudflare-origin-lock";

    public const string RefreshRequester = "the origin lock's daily refresh";

    private readonly SemaphoreSlim _gate = new(1, 1);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public override void Dispose()
    {
        _gate.Dispose();
        base.Dispose();
    }

    public async Task<OriginLockStatus> StatusAsync(CancellationToken cancellationToken)
    {
        var row = await LoadAsync(cancellationToken);
        var ranges = OriginLockRows.Ranges(row);
        var warnings = new List<string>();
        OriginLockComparison? comparison = null;
        if (ranges is not null)
        {
            try
            {
                comparison = OriginLockPlanner.Compare(await backends.Current().ReadAsync(cancellationToken), ranges);
            }
            catch (Exception failure) when (IsMachineFailure(failure))
            {
                warnings.Add($"The core could not read the firewall: {failure.Message}");
            }
        }

        FirewallChangeState? changeState = null;
        if (row?.ChangeSetId is { } changeSetId)
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            changeState = await db.FirewallChangeSets.AsNoTracking()
                .Where(change => change.Id == changeSetId)
                .Select(change => (FirewallChangeState?)change.State)
                .FirstOrDefaultAsync(cancellationToken);
        }

        var enabled = row?.Enabled == true;
        var state = !enabled ? OriginLockState.Off
            : changeState is FirewallChangeState.Applying or FirewallChangeState.AwaitingConfirmation ? OriginLockState.Pending
            : comparison is { Matches: true } ? OriginLockState.On
            : OriginLockState.Drifted;
        if (enabled && changeState == FirewallChangeState.RolledBack)
        {
            warnings.Add("The firewall change that turned the lock on was rolled back. Turn the lock on again, or off.");
        }

        return new OriginLockStatus(
            enabled,
            enabled && row!.AuthenticatedOriginPulls,
            state,
            [.. OriginLockPlanner.Ports],
            [.. comparison?.Missing ?? []],
            [.. comparison?.Open ?? []],
            [.. comparison?.Stale ?? []],
            [.. warnings],
            ranges,
            row?.LastRefreshAt,
            row?.LastRefreshError,
            row?.ChangeSetId,
            changeState);
    }

    public async Task<OriginLockPreview> PreviewAsync(OriginLockRequest? request, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var (plan, ranges) = await PlanAsync(request, cancellationToken);
        var preview = plan.Changes.Count == 0
            ? null
            : await firewall.PreviewAsync(new FirewallChangeRequest([.. plan.Changes], request.SshConnection), caller, cancellationToken);
        List<string> notes = [.. plan.Notes];
        if (preview is null)
        {
            notes.Add("The firewall already matches; only nginx changes.");
        }

        return new OriginLockPreview([.. plan.Changes], [.. notes], ranges, preview);
    }

    public async Task<OriginLockResult> ApplyAsync(OriginLockRequest? request, FirewallCaller caller, Requester who, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var (plan, ranges) = await PlanAsync(request, cancellationToken);
            FirewallChangeSetInfo? change = null;
            if (plan.Changes.Count > 0)
            {
                change = await firewall.ApplyAsync(new FirewallChangeRequest([.. plan.Changes], request.SshConnection, null), caller, cancellationToken);
            }

            await SaveAsync(
                row =>
                {
                    row.Enabled = request.Enabled;
                    row.AuthenticatedOriginPulls = request.Enabled && request.AuthenticatedOriginPulls;
                    OriginLockRows.SetRanges(row, ranges);
                    row.ChangeSetId = change?.Id ?? row.ChangeSetId;
                },
                CancellationToken.None);
            var nginx = await sites.ApplyAsync(who, CancellationToken.None);
            await alerts.ResolveAsync(AlertKind.OriginLockRefreshFailed, AlertResource, CancellationToken.None);
            return new OriginLockResult(await StatusAsync(CancellationToken.None), nginx, change);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Fetches the ranges. When they changed and the lock is on, the firewall and nginx follow:
    /// the firewall by the core itself, since nobody is there to confirm a daily refresh.
    /// </summary>
    public async Task<OriginLockStatus> RefreshAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await RefreshLockedAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }

        return await StatusAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.RunInBackground)
        {
            return;
        }

        await Task.Delay(options.FirstRefreshAfter, time, stoppingToken);
        await RefreshQuietlyAsync(stoppingToken);
        using var ticks = new PeriodicTimer(options.RefreshInterval, time);
        while (await ticks.WaitForNextTickAsync(stoppingToken))
        {
            await RefreshQuietlyAsync(stoppingToken);
        }
    }

    private async Task RefreshQuietlyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await RefreshAsync(cancellationToken);
        }
        catch (Exception failure) when (failure is not OperationCanceledException and not OutOfMemoryException)
        {
            LogRefreshFailed(logger, failure);
        }
    }

    private async Task RefreshLockedAsync(CancellationToken cancellationToken)
    {
        var row = await LoadAsync(cancellationToken);
        var previous = OriginLockRows.Ranges(row);
        CloudflareRanges fetched;
        try
        {
            fetched = await source.FetchAsync(cancellationToken) with { FetchedAtUnixMs = Now };
        }
        catch (CloudflareApiException failure)
        {
            await FailAsync(row?.Enabled == true, $"Cloudflare's ranges could not be fetched: {failure.Message}", cancellationToken);
            return;
        }

        var changed = previous is null || !previous.Ipv4.SequenceEqual(fetched.Ipv4) || !previous.Ipv6.SequenceEqual(fetched.Ipv6);
        await SaveAsync(
            saved =>
            {
                OriginLockRows.SetRanges(saved, fetched);
                saved.LastRefreshAt = Now;
                saved.LastRefreshError = null;
            },
            cancellationToken);
        if (row?.Enabled != true || !changed)
        {
            await alerts.ResolveAsync(AlertKind.OriginLockRefreshFailed, AlertResource, cancellationToken);
            return;
        }

        LogRangesChanged(logger, fetched.Ipv4.Length, fetched.Ipv6.Length);
        try
        {
            var state = await backends.Current().ReadAsync(cancellationToken);
            var plan = OriginLockPlanner.Plan(state, fetched, enable: true, previous is null ? null : [.. CloudflareRangeList.All(previous)]);
            if (plan.Changes.Count > 0)
            {
                var change = await firewall.ApplyUnattendedAsync(plan.Changes, RefreshRequester, OriginLockPlanner.Ports, cancellationToken);
                await SaveAsync(saved => saved.ChangeSetId = change.Id, CancellationToken.None);
            }
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            await FailAsync(true, $"Cloudflare's ranges changed, but the firewall could not be brought up to date: {failure.Message} Turn the lock on again from the Firewall section.", CancellationToken.None);
            return;
        }

        var nginx = await sites.ApplyAsync(who: null, CancellationToken.None);
        if (!nginx.Applied)
        {
            await FailAsync(true, $"Cloudflare's ranges changed, but nginx refused the new list: {nginx.Error ?? string.Join(" ", nginx.Problems.Select(p => p.Message))}", CancellationToken.None);
            return;
        }

        await alerts.ResolveAsync(AlertKind.OriginLockRefreshFailed, AlertResource, CancellationToken.None);
    }

    private async Task FailAsync(bool raise, string message, CancellationToken cancellationToken)
    {
        await SaveAsync(saved => (saved.LastRefreshAt, saved.LastRefreshError) = (Now, message.Length > 1000 ? message[..999] + "…" : message), cancellationToken);
        if (raise)
        {
            await alerts.RaiseAsync(AlertKind.OriginLockRefreshFailed, AlertResource, AlertSeverity.Warning, message, cancellationToken);
        }
    }

    /// <summary>The plan against the firewall as it is, with ranges fetched now unless the stored ones are fresh.</summary>
    private async Task<(OriginLockPlan Plan, CloudflareRanges Ranges)> PlanAsync(OriginLockRequest request, CancellationToken cancellationToken)
    {
        var row = await LoadAsync(cancellationToken);
        var stored = OriginLockRows.Ranges(row);
        var ranges = stored;
        if (stored is null || Now - stored.FetchedAtUnixMs > (long)options.FreshFor.TotalMilliseconds)
        {
            try
            {
                ranges = await source.FetchAsync(cancellationToken) with { FetchedAtUnixMs = Now };
            }
            catch (CloudflareApiException failure) when (stored is not null && !request.Enabled)
            {
                LogFetchFellBack(logger, failure.Message);
            }
            catch (CloudflareApiException failure)
            {
                throw new FirewallRefusedException($"Cloudflare's ranges could not be fetched, so the lock cannot be built: {failure.Message}");
            }
        }

        FirewallState state;
        try
        {
            state = await backends.Current().ReadAsync(cancellationToken);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            throw new FirewallRefusedException($"The core could not read the firewall, so it changes nothing: {failure.Message}");
        }

        var previous = stored is null ? null : CloudflareRangeList.All(stored).ToList();
        return (OriginLockPlanner.Plan(state, ranges!, request.Enabled, previous), ranges!);
    }

    private async Task<OriginLockSetting?> LoadAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.OriginLock.AsNoTracking().FirstOrDefaultAsync(setting => setting.Id == OriginLockSetting.SingletonId, cancellationToken);
    }

    private async Task SaveAsync(Action<OriginLockSetting> change, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.OriginLock.FirstOrDefaultAsync(setting => setting.Id == OriginLockSetting.SingletonId, cancellationToken);
        if (row is null)
        {
            row = new OriginLockSetting();
            db.OriginLock.Add(row);
        }

        change(row);
        row.UpdatedAt = Now;
        await db.SaveChangesAsync(cancellationToken);
    }

    private static bool IsMachineFailure(Exception failure) =>
        failure is FirewallRefusedException or FirewallStepFailedException or ProcessStartException or ProcessFailedException
            or IOException or UnauthorizedAccessException;

    [LoggerMessage(Level = LogLevel.Warning, Message = "Refreshing Cloudflare's ranges failed.")]
    private static partial void LogRefreshFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Information, Message = "Cloudflare's ranges changed ({Ipv4} IPv4, {Ipv6} IPv6); bringing the origin lock up to date.")]
    private static partial void LogRangesChanged(ILogger logger, int ipv4, int ipv6);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Cloudflare's ranges could not be fetched ({Reason}); turning the lock off with the stored ones.")]
    private static partial void LogFetchFellBack(ILogger logger, string reason);
}
