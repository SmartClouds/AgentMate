using System.Runtime.CompilerServices;
using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Web;

/// <summary>
/// A site's access and error logs, read from the files nginx writes: the last lines first, then
/// new ones as they arrive, noticing rotation. Lines are attacker-influenced text and go out as
/// such, clipped in length; the app shows them as text only.
/// </summary>
internal sealed class SiteLogs(INginxMachine machine, TimeProvider time)
{
    public const int DefaultTail = 100;
    public const int MaxTail = 1000;
    public const int MaxLineLength = 4096;

    /// <summary>One message stays well under the hub's 64 KB limit.</summary>
    public const int MaxBatchChars = 32 * 1024;

    private const int TailWindowBytes = 512 * 1024;
    private const int ReadChunk = 64 * 1024;

    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(1);

    public async IAsyncEnumerable<SiteLogBatch> StreamAsync(
        string path,
        int? tailLines,
        bool follow,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var tail = Math.Clamp(tailLines ?? DefaultTail, 0, MaxTail);
        var length = await machine.LengthAsync(path, cancellationToken) ?? 0;
        var start = Math.Max(0, length - TailWindowBytes);
        var lines = new List<string>();
        if (length > 0 && tail > 0)
        {
            var text = Encoding.UTF8.GetString(await machine.ReadRangeAsync(path, start, (int)(length - start), cancellationToken));
            var all = text.Split('\n');
            // A window that starts mid-file starts mid-line; that first piece is dropped.
            var complete = all.Skip(start > 0 ? 1 : 0).Take(all.Length - (start > 0 ? 1 : 0) - 1);
            lines.AddRange(complete.TakeLast(tail));
        }

        foreach (var batch in Batches(lines, reset: false))
        {
            yield return batch;
        }

        if (!follow)
        {
            yield break;
        }

        // Lines are split at newlines only; a line still being written waits for its end.
        var offset = length;
        var partial = new StringBuilder();
        var sentAnything = lines.Count > 0;
        if (!sentAnything)
        {
            yield return new SiteLogBatch([]);
        }

        while (true)
        {
            await Task.Delay(PollInterval, time, cancellationToken);
            var now = await machine.LengthAsync(path, cancellationToken) ?? 0;
            var reset = false;
            if (now < offset)
            {
                // Rotated or truncated: the file starts over.
                offset = 0;
                partial.Clear();
                reset = true;
            }

            var fresh = new List<string>();
            while (offset < now)
            {
                var bytes = await machine.ReadRangeAsync(path, offset, (int)Math.Min(ReadChunk, now - offset), cancellationToken);
                if (bytes.Length == 0)
                {
                    break;
                }

                offset += bytes.Length;
                partial.Append(Encoding.UTF8.GetString(bytes));
                var text = partial.ToString();
                var end = text.LastIndexOf('\n');
                if (end >= 0)
                {
                    fresh.AddRange(text[..end].Split('\n'));
                    partial.Clear().Append(text[(end + 1)..]);
                }

                if (partial.Length > MaxLineLength)
                {
                    fresh.Add(partial.ToString());
                    partial.Clear();
                }
            }

            if (fresh.Count > 0 || reset)
            {
                foreach (var batch in Batches(fresh, reset))
                {
                    yield return batch;
                }
            }
        }
    }

    private static IEnumerable<SiteLogBatch> Batches(List<string> lines, bool reset)
    {
        var batch = new List<string>();
        var chars = 0;
        foreach (var raw in lines)
        {
            var line = Clean(raw);
            if (batch.Count > 0 && chars + line.Length > MaxBatchChars)
            {
                yield return new SiteLogBatch([.. batch], reset);
                reset = false;
                batch.Clear();
                chars = 0;
            }

            batch.Add(line);
            chars += line.Length;
        }

        if (batch.Count > 0 || reset)
        {
            yield return new SiteLogBatch([.. batch], reset);
        }
    }

    /// <summary>Without the trailing CR, control characters made visible, and clipped.</summary>
    private static string Clean(string line)
    {
        var text = line.TrimEnd('\r');
        if (text.Length > MaxLineLength)
        {
            text = text[..MaxLineLength] + "…";
        }

        return text.Any(char.IsControl)
            ? new string([.. text.Select(c => char.IsControl(c) && c != '\t' ? '�' : c)])
            : text;
    }

    /// <summary>The file a request names, for a site that exists (checked by the caller).</summary>
    public static string PathOf(NginxLayout layout, string siteId, SiteLogKind kind)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return kind == SiteLogKind.Error ? layout.ErrorLog(siteId) : layout.AccessLog(siteId);
    }
}
