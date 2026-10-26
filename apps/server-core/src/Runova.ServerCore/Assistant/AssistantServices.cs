using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Runova.ServerCore.Assistant;

/// <summary>What the hub's exec and journal methods use, in one parameter.</summary>
internal sealed record AssistantHubServices(
    ExecApprovals Approvals,
    AssistantModes Modes,
    IExecRunner Runner,
    IJournalSource Journal,
    ExecSecrets Secrets);

internal static class AssistantServices
{
    /// <summary>
    /// The exec stream and the journal on Linux: commands in transient units, journalctl for logs.
    /// The DevHost and the tests register fakes after this, which take its place.
    /// </summary>
    public static IServiceCollection AddCoreAssistant(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ExecApprovals>();
        services.AddSingleton<AssistantModes>();
        services.AddSingleton<IExecRunner, SystemdExecRunner>();
        services.AddSingleton<IJournalSource, JournalctlSource>();
        services.AddSingleton<ExecSecrets>();
        services.AddSingleton<AssistantHubServices>();
        return services;
    }

    /// <summary>
    /// Whatever has arrived, in batches of up to <paramref name="max"/>: one message for a burst of
    /// lines rather than one a line, and nothing held back while the stream is quiet.
    /// </summary>
    public static async IAsyncEnumerable<T[]> BatchesAsync<T>(
        ChannelReader<T> reader,
        int max,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reader);
        var batch = new List<T>(max);
        while (await reader.WaitToReadAsync(cancellationToken))
        {
            while (batch.Count < max && reader.TryRead(out var item))
            {
                batch.Add(item);
            }

            if (batch.Count > 0)
            {
                yield return [.. batch];
                batch.Clear();
            }
        }
    }
}
