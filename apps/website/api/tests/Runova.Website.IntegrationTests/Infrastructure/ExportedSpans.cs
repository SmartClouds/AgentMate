using System.Collections.ObjectModel;
using System.Diagnostics;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// What the in-memory exporter collects. Spans end on request threads, so adding and reading are
/// locked.
/// </summary>
internal sealed class ExportedSpans : Collection<Activity>
{
    private readonly Lock _lock = new();

    /// <summary>Waits up to five seconds for a span that matches, then returns every span so far.</summary>
    public async Task<IReadOnlyList<Activity>> WaitForAsync(Func<Activity, bool> match)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (true)
        {
            var spans = Snapshot();
            if (spans.Any(match) || DateTime.UtcNow > deadline)
            {
                return spans;
            }

            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
    }

    public IReadOnlyList<Activity> Snapshot()
    {
        lock (_lock)
        {
            return [.. Items];
        }
    }

    protected override void InsertItem(int index, Activity item)
    {
        lock (_lock)
        {
            base.InsertItem(index, item);
        }
    }
}
