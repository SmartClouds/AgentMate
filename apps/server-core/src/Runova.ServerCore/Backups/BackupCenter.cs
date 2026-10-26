using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Backups;

/// <summary>What is sealed for a destination: the credentials as sent, and a Telegram account's session once signed in.</summary>
internal sealed record SealedDestinationSecret(BackupDestinationSecret Secret, string? TelegramSession);

/// <summary>A destination with its credentials unsealed, for one use.</summary>
internal sealed record ResolvedDestination(
    Guid Id,
    string Name,
    BackupDestinationKind Kind,
    BackupDestinationSettings Settings,
    BackupDestinationSecret Secret,
    string? TelegramSession,
    long? MaxPartBytes)
{
    public long? PartBytes => BackupDestinationRules.PartBytes(Kind, Settings, MaxPartBytes);
}

[JsonSerializable(typeof(BackupDestinationSettings))]
[JsonSerializable(typeof(SealedDestinationSecret))]
[JsonSerializable(typeof(BackupKeySlot))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
internal sealed partial class BackupStoreJson : JsonSerializerContext;

/// <summary>
/// The server backups' settings (E28): the key ring, the destinations and the plans, and the run
/// history. Refusals are <see cref="BackupRefusedException"/>s worded for the person.
/// </summary>
internal sealed class BackupCenter(
    IDbContextFactory<CoreDbContext> contexts,
    IDataProtectionProvider protection,
    BackupPlanScheduler scheduler,
    TimeProvider time)
{
    public const int MaxDestinationsPerPlan = 10;
    public const int PreviewRuns = 5;

    private readonly IDataProtector _secrets = protection.CreateProtector(FrozenIdentifiers.BackupDestinationPurpose);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    // The secret key.

    public async Task<BackupSecretStatus> GetSecretAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var ring = await db.BackupKeyRing.AsNoTracking().SingleOrDefaultAsync(cancellationToken);
        return new BackupSecretStatus(ring is not null, ring?.KeyId, ring?.UpdatedAt);
    }

    /// <summary>The key ring backups are encrypted to, or null until an Owner sets a secret.</summary>
    public async Task<BackupKeyRing?> GetKeyRingAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var ring = await db.BackupKeyRing.AsNoTracking().SingleOrDefaultAsync(cancellationToken);
        return ring is null ? null : ToKeyRing(ring);
    }

    public async Task<BackupSecretStatus> SetSecretAsync(SetBackupSecretRequest? request, CancellationToken cancellationToken)
    {
        var next = request?.NewSecret ?? string.Empty;
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var stored = await db.BackupKeyRing.SingleOrDefaultAsync(cancellationToken);
        if (stored is null)
        {
            var ring = BackupKeyRing.Create(next, Now);
            db.BackupKeyRing.Add(new BackupKeyRingRecord
            {
                KeyId = ring.KeyId,
                PublicKey = ring.PublicKey,
                Slot = JsonSerializer.Serialize(ring.Slot, BackupStoreJson.Default.BackupKeySlot),
                CreatedAt = Now,
                UpdatedAt = Now,
            });
        }
        else
        {
            if (string.IsNullOrEmpty(request?.CurrentSecret))
            {
                throw new BackupRefusedException("A secret key is set. Enter the current secret key to change it.");
            }

            BackupKeyRing changed;
            try
            {
                changed = ToKeyRing(stored).WithSecret(request.CurrentSecret, next);
            }
            catch (BackupRefusedException error) when (error.Message.Contains("is wrong", StringComparison.Ordinal))
            {
                throw new BackupRefusedException("The current secret key is wrong.", error);
            }

            stored.Slot = JsonSerializer.Serialize(changed.Slot, BackupStoreJson.Default.BackupKeySlot);
            stored.UpdatedAt = Now;
        }

        await db.SaveChangesAsync(cancellationToken);
        return await GetSecretAsync(cancellationToken);
    }

    // Destinations.

    public async Task<BackupDestinationInfo[]> ListDestinationsAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.BackupDestinations.AsNoTracking().OrderBy(d => d.Name).ToListAsync(cancellationToken);
        return [.. rows.Select(ToInfo)];
    }

    public async Task<BackupDestinationInfo> SaveDestinationAsync(SaveBackupDestinationRequest? request, string? telegramSession, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = request.Id is { } id
            ? await db.BackupDestinations.SingleOrDefaultAsync(d => d.Id == id, cancellationToken) ?? throw new BackupRefusedException("That destination is gone.")
            : null;
        if (row is not null && row.Kind != request.Kind)
        {
            throw new BackupRefusedException("A destination keeps its kind. Add a new one instead.");
        }

        var name = request.Name?.Trim() ?? string.Empty;
        if (BackupDestinationRules.Problem(name, request.Kind, request.Settings, request.Secret, row?.ProtectedSecret is not null, request.MaxPartBytes) is { } problem)
        {
            throw new BackupRefusedException(problem);
        }

        if (await db.BackupDestinations.AnyAsync(d => d.Name == name && d.Id != (row == null ? Guid.Empty : row.Id), cancellationToken))
        {
            throw new BackupRefusedException($"A destination called {name} is already there.");
        }

        if (row is null)
        {
            row = new BackupDestinationRecord { Id = Guid.NewGuid(), Name = name, Kind = request.Kind, Settings = "{}", CreatedAt = Now };
            db.BackupDestinations.Add(row);
        }

        row.Name = name;
        row.Settings = JsonSerializer.Serialize(Normalize(request.Kind, request.Settings), BackupStoreJson.Default.BackupDestinationSettings);
        row.MaxPartBytes = request.MaxPartBytes;
        row.UpdatedAt = Now;
        if (request.Secret is not null)
        {
            var sealedSecret = new SealedDestinationSecret(request.Secret, telegramSession);
            row.ProtectedSecret = _secrets.Protect(JsonSerializer.Serialize(sealedSecret, BackupStoreJson.Default.SealedDestinationSecret));
        }

        row.LastError = null;
        await db.SaveChangesAsync(cancellationToken);
        return ToInfo(row);
    }

    public async Task<bool> DeleteDestinationAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.BackupDestinations.Where(d => d.Id == id).ExecuteDeleteAsync(cancellationToken) > 0;
    }

    public async Task<ResolvedDestination?> OpenDestinationAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.BackupDestinations.AsNoTracking().SingleOrDefaultAsync(d => d.Id == id, cancellationToken);
        return row is null ? null : Resolve(row);
    }

    /// <summary>A destination as a request describes it, before it is saved: for a test. Without a secret, the stored one.</summary>
    public async Task<ResolvedDestination> ResolveDraftAsync(SaveBackupDestinationRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var stored = request.Id is { } id ? await OpenDestinationAsync(id, cancellationToken) : null;
        if (request.Secret is null && stored is null && request.Kind != BackupDestinationKind.Folder)
        {
            throw new BackupRefusedException("Enter the destination's credentials to test it.");
        }

        return new ResolvedDestination(
            stored?.Id ?? Guid.Empty,
            request.Name ?? string.Empty,
            request.Kind,
            Normalize(request.Kind, request.Settings),
            request.Secret ?? stored?.Secret ?? new BackupDestinationSecret(),
            stored?.TelegramSession,
            request.MaxPartBytes);
    }

    /// <summary>Seals a Telegram session again once it changed in use.</summary>
    public async Task UpdateTelegramSessionAsync(Guid id, string session, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.BackupDestinations.SingleOrDefaultAsync(d => d.Id == id, cancellationToken);
        if (row?.ProtectedSecret is null)
        {
            return;
        }

        var stored = JsonSerializer.Deserialize(_secrets.Unprotect(row.ProtectedSecret), BackupStoreJson.Default.SealedDestinationSecret)!;
        row.ProtectedSecret = _secrets.Protect(JsonSerializer.Serialize(stored with { TelegramSession = session }, BackupStoreJson.Default.SealedDestinationSecret));
        await db.SaveChangesAsync(cancellationToken);
    }

    /// <summary>Seals a refresh token the provider rotated in place of the old one (OneDrive does on every use).</summary>
    public async Task UpdateRefreshTokenAsync(Guid id, string refreshToken, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.BackupDestinations.SingleOrDefaultAsync(d => d.Id == id, cancellationToken);
        if (row?.ProtectedSecret is null)
        {
            return;
        }

        var stored = JsonSerializer.Deserialize(_secrets.Unprotect(row.ProtectedSecret), BackupStoreJson.Default.SealedDestinationSecret)!;
        var updated = stored with { Secret = stored.Secret with { RefreshToken = refreshToken } };
        row.ProtectedSecret = _secrets.Protect(JsonSerializer.Serialize(updated, BackupStoreJson.Default.SealedDestinationSecret));
        row.UpdatedAt = Now;
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task RecordDestinationOutcomeAsync(Guid id, string? error, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var trimmed = error is { Length: > 1000 } ? error[..1000] : error;
        await db.BackupDestinations.Where(d => d.Id == id).ExecuteUpdateAsync(
            set => set.SetProperty(d => d.LastTestedAt, Now).SetProperty(d => d.LastError, trimmed),
            cancellationToken);
    }

    // Plans.

    public async Task<BackupPlanInfo[]> ListPlansAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var plans = await db.BackupPlans.AsNoTracking().OrderBy(p => p.Name).ToListAsync(cancellationToken);
        var result = new List<BackupPlanInfo>(plans.Count);
        foreach (var plan in plans)
        {
            result.Add(await ToInfoAsync(db, plan, cancellationToken));
        }

        return [.. result];
    }

    public async Task<BackupPlanRecord?> FindPlanAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.BackupPlans.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id, cancellationToken);
    }

    public async Task<Guid[]> PlanDestinationsAsync(Guid planId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.BackupPlanDestinations.Where(t => t.PlanId == planId).Select(t => t.DestinationId).ToArrayAsync(cancellationToken);
    }

    public async Task<BackupPlanInfo> SavePlanAsync(SaveBackupPlanRequest? request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var name = request.Name?.Trim() ?? string.Empty;
        var destinations = (request.DestinationIds ?? []).Distinct().ToArray();
        var rule = new RetentionRule(request.KeepLast, request.KeepDays);
        var problem = name.Length is 0 or > BackupDestinationRules.MaxNameLength
            ? "Give the plan a name of at most 100 characters."
            : BackupPlanScheduler.ScheduleProblem(request.Cron, request.TimeZone)
                ?? rule.Problem()
                ?? (destinations.Length is 0 or > MaxDestinationsPerPlan ? $"Pick between 1 and {MaxDestinationsPerPlan} destinations." : null);
        if (problem is not null)
        {
            throw new BackupRefusedException(problem);
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        if (await db.BackupDestinations.CountAsync(d => destinations.Contains(d.Id), cancellationToken) != destinations.Length)
        {
            throw new BackupRefusedException("A destination the plan names is gone. Pick them again.");
        }

        var plan = request.Id is { } id
            ? await db.BackupPlans.SingleOrDefaultAsync(p => p.Id == id, cancellationToken) ?? throw new BackupRefusedException("That plan is gone.")
            : null;
        if (await db.BackupPlans.AnyAsync(p => p.Name == name && p.Id != (plan == null ? Guid.Empty : plan.Id), cancellationToken))
        {
            throw new BackupRefusedException($"A plan called {name} is already there.");
        }

        if (plan is null)
        {
            plan = new BackupPlanRecord { Id = Guid.NewGuid(), Name = name, Cron = request.Cron, TimeZone = request.TimeZone, CreatedAt = Now };
            db.BackupPlans.Add(plan);
        }

        plan.Name = name;
        plan.Enabled = request.Enabled;
        plan.Cron = request.Cron.Trim();
        plan.TimeZone = request.TimeZone.Trim();
        plan.KeepLast = request.KeepLast;
        plan.KeepDays = request.KeepDays;
        plan.UpdatedAt = Now;
        await db.BackupPlanDestinations.Where(t => t.PlanId == plan.Id).ExecuteDeleteAsync(cancellationToken);
        db.BackupPlanDestinations.AddRange(destinations.Select(destination => new BackupPlanDestinationRecord { PlanId = plan.Id, DestinationId = destination }));
        await db.SaveChangesAsync(cancellationToken);
        scheduler.Apply(plan);
        return await ToInfoAsync(db, plan, cancellationToken);
    }

    public async Task<bool> DeletePlanAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var deleted = await db.BackupPlans.Where(p => p.Id == id).ExecuteDeleteAsync(cancellationToken) > 0;
        scheduler.Remove(id);
        return deleted;
    }

    public async Task<BackupPlanPreview> PreviewAsync(BackupPlanPreviewRequest? request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var rule = new RetentionRule(request.KeepLast, request.KeepDays);
        if ((BackupPlanScheduler.ScheduleProblem(request.Cron, request.TimeZone) ?? rule.Problem()) is { } problem)
        {
            return new BackupPlanPreview(problem, [], 0, null, null, 0);
        }

        var runs = BackupPlanScheduler.NextRuns(request.Cron, request.TimeZone, time.GetUtcNow(), Math.Min(rule.KeepLast + 2, RetentionRule.MaxKeepLast + 2));
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var existing = request.PlanId is { } planId
            ? await db.BackupRuns.CountAsync(r => r.PlanId == planId && (r.State == BackupRunState.Succeeded || r.State == BackupRunState.PartlyFailed), cancellationToken)
            : 0;
        var lastSize = await db.BackupRuns
            .Where(r => r.SizeBytes != null && (request.PlanId == null || r.PlanId == request.PlanId))
            .OrderByDescending(r => r.StartedAt)
            .Select(r => r.SizeBytes)
            .FirstOrDefaultAsync(cancellationToken);
        var preview = RetentionPlanner.Preview(runs, rule, lastSize, existing);
        return new BackupPlanPreview(null, [.. runs.Take(PreviewRuns)], preview.Kept, preview.BytesPerDestination, preview.FirstDeletionAtUnixMs, preview.CoversMs);
    }

    // Runs.

    public async Task<BackupRunInfo[]> ListRunsAsync(int limit, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var runs = await db.BackupRuns.AsNoTracking().OrderByDescending(r => r.StartedAt).Take(Math.Clamp(limit, 1, 200)).ToListAsync(cancellationToken);
        var ids = runs.Select(r => r.Id).ToList();
        var targets = await db.BackupRunTargets.AsNoTracking().Where(t => ids.Contains(t.RunId)).ToListAsync(cancellationToken);
        return [.. runs.Select(run => ToInfo(run, targets.Where(t => t.RunId == run.Id)))];
    }

    public async Task<BackupRunInfo?> FindRunAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var run = await db.BackupRuns.AsNoTracking().SingleOrDefaultAsync(r => r.Id == id, cancellationToken);
        if (run is null)
        {
            return null;
        }

        var targets = await db.BackupRunTargets.AsNoTracking().Where(t => t.RunId == id).ToListAsync(cancellationToken);
        return ToInfo(run, targets);
    }

    internal static BackupRunInfo ToInfo(BackupRunRecord run, IEnumerable<BackupRunTargetRecord> targets) =>
        new(
            run.Id,
            run.PlanId,
            run.PlanName,
            run.Trigger,
            run.State,
            run.StartedAt,
            run.FinishedAt,
            run.SizeBytes,
            run.Error,
            run.RequestedByName,
            [.. targets.OrderBy(t => t.DestinationName).Select(t => new BackupRunTargetInfo(t.DestinationId, t.DestinationName, t.State, t.Attempts, t.Pruned, t.Error))]);

    private async Task<BackupPlanInfo> ToInfoAsync(CoreDbContext db, BackupPlanRecord plan, CancellationToken cancellationToken)
    {
        var destinations = await db.BackupPlanDestinations.AsNoTracking().Where(t => t.PlanId == plan.Id).Select(t => t.DestinationId).ToArrayAsync(cancellationToken);
        var last = await db.BackupRuns.AsNoTracking().Where(r => r.PlanId == plan.Id).OrderByDescending(r => r.StartedAt).FirstOrDefaultAsync(cancellationToken);
        BackupRunInfo? lastRun = null;
        if (last is not null)
        {
            var targets = await db.BackupRunTargets.AsNoTracking().Where(t => t.RunId == last.Id).ToListAsync(cancellationToken);
            lastRun = ToInfo(last, targets);
        }

        var next = plan.Enabled ? BackupPlanScheduler.NextRuns(plan.Cron, plan.TimeZone, time.GetUtcNow(), 1) : [];
        return new BackupPlanInfo(plan.Id, plan.Name, plan.Enabled, plan.Cron, plan.TimeZone, plan.KeepLast, plan.KeepDays, destinations, next.Count > 0 ? next[0] : null, lastRun);
    }

    private ResolvedDestination Resolve(BackupDestinationRecord row)
    {
        var settings = ReadSettings(row);
        SealedDestinationSecret? sealedSecret = null;
        if (row.ProtectedSecret is not null)
        {
            sealedSecret = JsonSerializer.Deserialize(_secrets.Unprotect(row.ProtectedSecret), BackupStoreJson.Default.SealedDestinationSecret);
        }

        return new ResolvedDestination(
            row.Id,
            row.Name,
            row.Kind,
            settings,
            sealedSecret?.Secret ?? new BackupDestinationSecret(),
            sealedSecret?.TelegramSession,
            row.MaxPartBytes);
    }

    private static BackupDestinationInfo ToInfo(BackupDestinationRecord row)
    {
        var settings = ReadSettings(row);
        return new BackupDestinationInfo(
            row.Id,
            row.Name,
            row.Kind,
            BackupDestinationRules.Summary(row.Kind, settings),
            settings,
            row.ProtectedSecret is not null,
            row.MaxPartBytes,
            row.LastTestedAt,
            row.LastError);
    }

    private static BackupDestinationSettings ReadSettings(BackupDestinationRecord row) =>
        JsonSerializer.Deserialize(row.Settings, BackupStoreJson.Default.BackupDestinationSettings) ?? new BackupDestinationSettings();

    /// <summary>Fills the defaults a kind has, so what is stored reads the same as what a list shows.</summary>
    private static BackupDestinationSettings Normalize(BackupDestinationKind kind, BackupDestinationSettings? settings)
    {
        settings ??= new BackupDestinationSettings();
        return kind switch
        {
            BackupDestinationKind.Ftp => settings with { Port = settings.Port ?? 21, Path = settings.Path ?? "/", Host = settings.Host?.Trim() },
            BackupDestinationKind.Sftp => settings with { Port = settings.Port ?? 22, Path = settings.Path ?? "/", Host = settings.Host?.Trim() },
            BackupDestinationKind.GoogleDrive or BackupDestinationKind.OneDrive => settings with { FolderName = settings.FolderName ?? BackupDestinationRules.DefaultFolderName },
            BackupDestinationKind.Telegram => settings with { Chat = settings.Chat ?? "me" },
            _ => settings,
        };
    }

    private static BackupKeyRing ToKeyRing(BackupKeyRingRecord row) =>
        new(row.KeyId, row.PublicKey, JsonSerializer.Deserialize(row.Slot, BackupStoreJson.Default.BackupKeySlot)!, row.CreatedAt);
}
