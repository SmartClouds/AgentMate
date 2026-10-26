using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Metrics;

/// <summary>Minute and quarter-hour averages in SQLite: 1-minute rows for 48 hours, 15-minute rows for 30 days.</summary>
internal sealed class MetricsStore(IDbContextFactory<CoreDbContext> contexts)
{
    public const int Minute = 60;

    public const int QuarterHour = 900;

    public static readonly TimeSpan KeepMinutes = TimeSpan.FromHours(48);

    public static readonly TimeSpan KeepQuarterHours = TimeSpan.FromDays(30);

    /// <summary>Stores the average of a period, replacing one written for it before (a restart in the same minute).</summary>
    public async Task SaveAsync(int resolution, MetricsSample average, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(average);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        await using var transaction = await CoreDatabase.BeginWriteAsync(db, cancellationToken);
        await db.MetricSamples
            .Where(row => row.Resolution == resolution && row.At == average.AtUnixMs)
            .ExecuteDeleteAsync(cancellationToken);
        db.MetricSamples.Add(ToRow(resolution, average));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<MetricsSample>> ReadAsync(
        int resolution,
        long fromUnixMs,
        long toUnixMs,
        int limit,
        CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.MetricSamples
            .AsNoTracking()
            .Where(row => row.Resolution == resolution && row.At >= fromUnixMs && row.At < toUnixMs)
            .OrderByDescending(row => row.At)
            .Take(limit)
            .ToListAsync(cancellationToken);
        return [.. rows.OrderBy(row => row.At).Select(ToSample)];
    }

    public async Task<int> PruneAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var minutes = (now - KeepMinutes).ToUnixTimeMilliseconds();
        var quarters = (now - KeepQuarterHours).ToUnixTimeMilliseconds();
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.MetricSamples
            .Where(row => (row.Resolution == Minute && row.At < minutes) || (row.Resolution == QuarterHour && row.At < quarters))
            .ExecuteDeleteAsync(cancellationToken);
    }

    private static MetricSample ToRow(int resolution, MetricsSample sample) => new()
    {
        Resolution = resolution,
        At = sample.AtUnixMs,
        CpuPercent = sample.CpuPercent,
        CpuIowaitPercent = sample.CpuIowaitPercent,
        CpuStealPercent = sample.CpuStealPercent,
        Load1 = sample.Load1,
        Load5 = sample.Load5,
        Load15 = sample.Load15,
        MemoryTotalBytes = sample.MemoryTotalBytes,
        MemoryUsedBytes = sample.MemoryUsedBytes,
        SwapTotalBytes = sample.SwapTotalBytes,
        SwapUsedBytes = sample.SwapUsedBytes,
        NetworkReceiveBytesPerSecond = sample.NetworkReceiveBytesPerSecond,
        NetworkTransmitBytesPerSecond = sample.NetworkTransmitBytesPerSecond,
        DiskReadBytesPerSecond = sample.DiskReadBytesPerSecond,
        DiskWriteBytesPerSecond = sample.DiskWriteBytesPerSecond,
        DiskTotalBytes = sample.DiskTotalBytes,
        DiskUsedBytes = sample.DiskUsedBytes,
    };

    private static MetricsSample ToSample(MetricSample row) => new(
        row.At,
        row.CpuPercent,
        row.CpuIowaitPercent,
        row.CpuStealPercent,
        row.Load1,
        row.Load5,
        row.Load15,
        row.MemoryTotalBytes,
        row.MemoryUsedBytes,
        row.SwapTotalBytes,
        row.SwapUsedBytes,
        row.NetworkReceiveBytesPerSecond,
        row.NetworkTransmitBytesPerSecond,
        row.DiskReadBytesPerSecond,
        row.DiskWriteBytesPerSecond,
        row.DiskTotalBytes,
        row.DiskUsedBytes);
}
