using Tapper;

namespace Runova.ServerCore.Contracts;

/// <summary>
/// Answer of the anonymous health endpoint: which core and API version is running, and since when
/// (the app shows the uptime from it). Cores from before the rename send neither Layout nor
/// MigrationError; the app reads that as the legacy layout.
/// </summary>
/// <param name="Layout">The layout the core runs in.</param>
/// <param name="MigrationError">Why the last layout migration was put back, while the core still runs in the legacy layout.</param>
[TranspilationSource]
public sealed record HealthResponse(
    string Status,
    string Version,
    int ApiVersion,
    long StartedAtUnixMs,
    CoreLayoutName? Layout = null,
    string? MigrationError = null);

/// <summary>Answer of the hub's ping, used for latency and to spot clock skew on the server.</summary>
[TranspilationSource]
public sealed record PingResponse(long ServerTimeUnixMs);
