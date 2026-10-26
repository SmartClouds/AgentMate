using Runova.ServerCore.Jobs;
using Runova.ServerCore.Registries;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Registry sign-ins for a deploy (E08). The ones the app sent come in with the request; once the
/// validate step knows which registries the images come from, stored credentials fill in for the
/// rest. Then they go into the job's tmpfs DOCKER_CONFIG, which the pull, build and up steps use
/// and the end of the job wipes, however it ends.
/// </summary>
internal sealed partial class StackOperations
{
    /// <summary>What a deploy signs in with, and the folder it lives in once written.</summary>
    internal sealed class DeploySignIns(IReadOnlyList<RegistryLogin> requested) : IDisposable
    {
        public IReadOnlyList<RegistryLogin> Requested { get; } = requested;

        public DockerConfigLease? Lease { get; set; }

        /// <summary>DOCKER_CONFIG for the steps, or null when there is nothing to sign in with.</summary>
        public IReadOnlyDictionary<string, string>? Environment => Lease?.Environment;

        public void Dispose()
        {
            Lease?.Dispose();
            Lease = null;
        }
    }

    /// <summary>The secret and the base64 form docker writes, so neither ever shows in the job's log.</summary>
    private static IEnumerable<string> RegistrySecrets(IEnumerable<RegistryLogin> logins) =>
        logins.SelectMany(login => new[] { login.Secret, RegistryAuthFolders.BasicAuth(login) });

    private async Task SignInAsync(DeploySignIns signIns, CheckedConfig config, JobContext job, CancellationToken token)
    {
        if (signIns.Lease is not null)
        {
            return;
        }

        // A build's base images can come from anywhere, so a stack that builds gets every stored credential.
        var wanted = config.Builds
            ? null
            : config.Registries.Where(host => !signIns.Requested.Any(login => login.Registry == host)).ToList();
        var stored = wanted is { Count: 0 } ? [] : await registries.UnsealAsync(wanted, token);
        var logins = RegistryCredentials.Merge(signIns.Requested, stored);
        if (logins.Count == 0)
        {
            return;
        }

        job.Seed(RegistrySecrets(logins));
        foreach (var login in logins)
        {
            job.Log(login.Source == RegistryLoginSource.Request
                ? $"Signing in to {login.Registry} as {login.Username} with the sign-in this deploy brought."
                : $"Signing in to {login.Registry} as {login.Username} with the credential stored on this server.");
        }

        try
        {
            signIns.Lease = registryFolders.Create(job.Id, logins);
        }
        catch (RegistryAuthUnavailableException unavailable)
        {
            throw new JobFailedException(unavailable.Message);
        }
    }
}
