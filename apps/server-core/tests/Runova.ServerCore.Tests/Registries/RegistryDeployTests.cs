using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Stacks;

namespace Runova.ServerCore.Tests.Registries;

/// <summary>
/// A deploy that pulls from a private registry (E08 T3), on the pretend engine and the simulated
/// compose: the sign-in the app sends is in the job's DOCKER_CONFIG while the pull runs, and once
/// the job ends (succeeded or failed) it is nowhere on disk, nor in the job's log, the audit
/// trail, a command line or anything the hub sends back.
/// </summary>
public sealed class RegistryDeployTests
{
    public const string Registry = "ghcr.io";

    public const string User = "octocat";

    public const string Token = "ghp_privateRegistryDeployToken0123456789";

    public const string Compose = """
        services:
          web:
            image: ghcr.io/acme/private-web:1.0
            restart: unless-stopped
            ports:
              - "8080:80"
        """;

    private static CancellationToken Cancel => StackKit.Cancel;

    private static readonly RegistryAuth[] _signIn = [new(Registry, User, Token)];

    /// <summary>The token and the base64 form docker writes for it.</summary>
    public static readonly string[] Forms = [Token, Convert.ToBase64String(Encoding.UTF8.GetBytes($"{User}:{Token}"))];

    internal static async Task<StackKit> KitAsync(string role = CoreRoles.Operator)
    {
        var kit = await StackKit.CreateAsync(role);
        kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>().PrivateRegistries[Registry] = (User, Token);
        return kit;
    }

    internal static Task<JobInfo> DeployAsync(StackKit kit, Guid stackId, int revision, RegistryAuth[]? auths) =>
        kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.DeployStackWithRegistries), new StackDeployRequest(stackId, revision, auths), Cancel);

    private static string RegistryRoot(StackKit kit) => kit.Harness.Services.GetRequiredService<RegistryAuthFolders>().Root;

    /// <summary>Every file the core wrote (database, WAL, job logs, stacks, keys, runtime) holding the token in either form.</summary>
    internal static List<string> FilesHoldingTheToken(StackKit kit)
    {
        var found = new List<string>();
        foreach (var file in Directory.EnumerateFiles(kit.DataDirectory, "*", SearchOption.AllDirectories))
        {
            var bytes = ReadAll(file);
            if (bytes is not null && Forms.Any(form => bytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(form)) >= 0))
            {
                found.Add(file);
            }
        }

        return found;
    }

    /// <summary>
    /// The whole file, or null when it went away meanwhile. SQLite on Windows locks byte ranges of
    /// the database while it writes, so a read can meet a lock for a moment: it is tried again
    /// rather than skipped, and a file that stays locked fails the test.
    /// </summary>
    private static byte[]? ReadAll(string file)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var copy = new MemoryStream();
                stream.CopyTo(copy);
                return copy.ToArray();
            }
            catch (FileNotFoundException)
            {
                return null;
            }
            catch (DirectoryNotFoundException)
            {
                return null;
            }
            catch (IOException) when (attempt < 50)
            {
                Thread.Sleep(100);
            }
        }
    }

    private static void HasNoToken(string? text)
    {
        foreach (var form in Forms)
        {
            Assert.DoesNotContain(form, text ?? string.Empty, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task The_sign_in_is_there_for_the_pull_and_gone_after_the_deploy()
    {
        await using var kit = await KitAsync();
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(Compose));

        var started = await DeployAsync(kit, stack.Id, revision.Number, _signIn);
        var (job, log) = await kit.RunAsync(started);
        var details = await kit.GetAsync(stack.Id);

        Assert.Equal(JobState.Succeeded, job.State);
        var pull = Assert.Single(kit.Simulated.DockerConfigs, entry => entry.Command == "pull");
        Assert.NotNull(pull.Folder);
        Assert.StartsWith(RegistryRoot(kit), pull.Folder, StringComparison.Ordinal);
        Assert.Contains(Forms[1], pull.Config, StringComparison.Ordinal);
        Assert.Contains(kit.Simulated.DockerConfigs, entry => entry.Command == "up" && entry.Folder == pull.Folder);
        Assert.Contains(kit.Simulated.DockerConfigs, entry => entry.Command == "config" && entry.Folder is null);
        Assert.False(Directory.Exists(pull.Folder));
        Assert.Empty(FilesHoldingTheToken(kit));
        Assert.Contains(log, line => line.Text.Contains("Signing in to ghcr.io as octocat with the sign-in this deploy brought.", StringComparison.Ordinal));
        Assert.All(log, line => HasNoToken(line.Text));
        Assert.All(kit.Simulated.Calls, HasNoToken);
        HasNoToken(JsonSerializer.Serialize(job, CoreJson.Options));
        HasNoToken(JsonSerializer.Serialize(started, CoreJson.Options));
        HasNoToken(JsonSerializer.Serialize(details, CoreJson.Options));
        var audit = await kit.AuditAsync();
        Assert.Contains(audit, e => e.Action == "stack.deploy" && e.Result == "success" && e.Parameters!.Contains("ghcr.io", StringComparison.Ordinal));
        Assert.All(audit, e => HasNoToken(e.Parameters));
    }

    [Fact]
    public async Task A_failed_deploy_leaves_no_token_either()
    {
        await using var kit = await KitAsync();
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(Compose));
        kit.Simulated.Failing["up"] = true;

        var (job, log) = await kit.RunAsync(await DeployAsync(kit, stack.Id, revision.Number, _signIn));

        Assert.Equal(JobState.Failed, job.State);
        var pull = Assert.Single(kit.Simulated.DockerConfigs, entry => entry.Command == "pull");
        Assert.Contains(Forms[1], pull.Config, StringComparison.Ordinal);
        Assert.False(Directory.Exists(pull.Folder));
        Assert.Empty(Directory.EnumerateFileSystemEntries(RegistryRoot(kit)));
        Assert.Empty(FilesHoldingTheToken(kit));
        Assert.All(log, line => HasNoToken(line.Text));
    }

    [Fact]
    public async Task Without_a_sign_in_the_private_pull_is_refused_with_the_registry_named()
    {
        await using var kit = await KitAsync();
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(Compose));

        var (job, log) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var details = await kit.GetAsync(stack.Id);

        Assert.Equal(JobState.Failed, job.State);
        Assert.Contains(log, line => line.Text.Contains("unauthorized: authentication required", StringComparison.Ordinal));
        var pullStep = details.Revisions[0].Steps.Single(step => step.Kind == StackStepKind.Pull);
        Assert.Equal(StackStepState.Failed, pullStep.State);
        Assert.Null(Assert.Single(kit.Simulated.DockerConfigs, entry => entry.Command == "pull").Folder);
    }

    [Fact]
    public async Task A_rollback_takes_the_sign_ins_along()
    {
        await using var kit = await KitAsync();
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload(Compose));
        await kit.RunAsync(await DeployAsync(kit, stack.Id, 1, _signIn));
        await kit.UploadAsync(stack.Id, StackKit.Upload(Compose.Replace("1.0", "1.1", StringComparison.Ordinal)));
        await kit.RunAsync(await DeployAsync(kit, stack.Id, 2, _signIn));

        var (job, _) = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(
            nameof(ICoreHub.RollbackStackWithRegistries),
            new StackDeployRequest(stack.Id, 1, _signIn),
            Cancel));

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(3, kit.Simulated.DockerConfigs.Count(entry => entry.Command == "pull" && entry.Config is not null));
        Assert.Empty(FilesHoldingTheToken(kit));
    }

    [Theory]
    [InlineData("ghcr.io", "has:colon", Token)]
    [InlineData("not a host", User, Token)]
    [InlineData("ghcr.io", User, "two\nlines")]
    public async Task A_sign_in_that_is_not_valid_is_refused_and_audited_without_it(string registry, string user, string secret)
    {
        await using var kit = await KitAsync();
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload(Compose));

        var refused = await Assert.ThrowsAsync<HubException>(() => DeployAsync(kit, stack.Id, 1, [new RegistryAuth(registry, user, secret)]));

        Assert.Contains("not valid", refused.Message, StringComparison.Ordinal);
        var audit = await kit.AuditAsync();
        Assert.Contains(audit, e => e.Action == "stack.deploy" && e.Result == "denied");
        Assert.All(audit, e => HasNoToken(e.Parameters));
    }

    [Fact]
    public async Task One_sign_in_per_registry_and_a_cap_on_how_many()
    {
        await using var kit = await KitAsync();
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload(Compose));

        var twice = await Assert.ThrowsAsync<HubException>(() => DeployAsync(kit, stack.Id, 1, [.. _signIn, new RegistryAuth("GHCR.io", User, Token)]));
        var many = await Assert.ThrowsAsync<HubException>(() => DeployAsync(
            kit,
            stack.Id,
            1,
            [.. Enumerable.Range(1, 11).Select(n => new RegistryAuth($"r{n}.example.com", User, Token))]));

        Assert.Contains("twice", twice.Message, StringComparison.Ordinal);
        Assert.Contains("at most 10", many.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Arguments_print_without_their_secrets()
    {
        HasNoToken(new RegistryAuth(Registry, User, Token).ToString());
        HasNoToken(new SaveRegistryCredentialRequest(Registry, User, Token).ToString());
        HasNoToken(new RegistryLogin(Registry, User, Token, RegistryLoginSource.Request).ToString());
    }
}
