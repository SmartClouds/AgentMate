namespace Runova.ServerCore;

/// <summary>When this core process started, for the uptime the app shows.</summary>
internal sealed class CoreStartup(TimeProvider time)
{
    public long StartedAtUnixMs { get; } = time.GetUtcNow().ToUnixTimeMilliseconds();
}
