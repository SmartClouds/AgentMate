using Tapper;

namespace Runova.ServerCore.Contracts;

// Private registries (E08). A deploy can carry registry sign-ins from the app (a GitHub packages
// token, Docker Hub or a custom registry); the core writes them to a DOCKER_CONFIG in memory
// (tmpfs) for that one job and wipes it when the job ends, however it ends. A credential can also
// be stored on the server, sealed with Data Protection, for pulls nobody is there to sign in for.
// Stored secrets are write-only: nothing the core sends back carries one.

/// <summary>
/// A registry sign-in that travels with one deploy or pull. Registry is a host such as ghcr.io,
/// docker.io or registry.example.com:5000.
/// </summary>
[TranspilationSource]
public sealed record RegistryAuth(string Registry, string Username, string Secret)
{
    /// <summary>Never the secret: SignalR's debug log and exception messages print arguments.</summary>
    public override string ToString() => $"RegistryAuth {{ Registry = {Registry}, Username = {Username}, Secret = [redacted] }}";
}

/// <summary>A deploy (or a rollback to Revision) with the sign-ins this computer sends for it.</summary>
[TranspilationSource]
public sealed record StackDeployRequest(Guid StackId, int Revision, RegistryAuth[]? Registries = null);

/// <summary>A credential stored on the server. The secret never comes back.</summary>
[TranspilationSource]
public sealed record RegistryCredentialInfo(
    Guid Id,
    string Registry,
    string Username,
    long CreatedAtUnixMs,
    long UpdatedAtUnixMs,
    string? CreatedBy = null,
    long? LastUsedAtUnixMs = null);

/// <summary>Stores (or replaces) the server's credential for a registry. Admin, with a recent step-up.</summary>
[TranspilationSource]
public sealed record SaveRegistryCredentialRequest(string Registry, string Username, string Secret)
{
    public override string ToString() => $"SaveRegistryCredentialRequest {{ Registry = {Registry}, Username = {Username}, Secret = [redacted] }}";
}
