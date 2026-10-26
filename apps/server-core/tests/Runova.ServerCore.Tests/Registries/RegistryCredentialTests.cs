using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Stacks;

namespace Runova.ServerCore.Tests.Registries;

/// <summary>
/// Credentials stored on the server (E08 T4): Admins with a recent step-up store them, nobody reads
/// them back, a deploy without sign-ins of its own uses them, and the row is useless without the
/// core's Data Protection keys (AC3).
/// </summary>
public sealed class RegistryCredentialTests
{
    private const string Token = RegistryDeployTests.Token;

    private static CancellationToken Cancel => StackKit.Cancel;

    private static readonly SaveRegistryCredentialRequest _save = new("GHCR.io", RegistryDeployTests.User, Token);

    private static Task<StepUpResponse> StepUpAsync(StackKit kit) =>
        kit.Hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);

    private static Task<RegistryCredentialInfo> SaveAsync(StackKit kit, SaveRegistryCredentialRequest? request = null) =>
        kit.Hub.InvokeAsync<RegistryCredentialInfo>(nameof(ICoreHub.SaveRegistryCredential), request ?? _save, Cancel);

    private static Task<RegistryCredentialInfo[]> ListAsync(StackKit kit) =>
        kit.Hub.InvokeAsync<RegistryCredentialInfo[]>(nameof(ICoreHub.ListRegistryCredentials), Cancel);

    private static async Task<RegistryCredentialRecord> RawRowAsync(StackKit kit)
    {
        await using var scope = kit.Harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().RegistryCredentials.AsNoTracking().SingleAsync(Cancel);
    }

    [Fact]
    public async Task An_admin_stores_a_credential_after_a_step_up_and_never_gets_the_secret_back()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Admin);

        var withoutStepUp = await Assert.ThrowsAsync<HubException>(() => SaveAsync(kit));
        await StepUpAsync(kit);
        var saved = await SaveAsync(kit);
        var listed = await ListAsync(kit);

        Assert.Contains("unauthorized", withoutStepUp.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(("ghcr.io", RegistryDeployTests.User, "maria"), (saved.Registry, saved.Username, saved.CreatedBy));
        Assert.Equal(saved.Id, Assert.Single(listed).Id);
        Assert.DoesNotContain(Token, JsonSerializer.Serialize(listed, CoreJson.Options), StringComparison.Ordinal);
        Assert.DoesNotContain(Token, JsonSerializer.Serialize(saved, CoreJson.Options), StringComparison.Ordinal);
        var audit = await kit.AuditAsync();
        Assert.Contains(audit, e => e.Action == "registry.credential-save" && e.Result == "success" && e.Target == "ghcr.io");
        Assert.All(audit, e => Assert.DoesNotContain(Token, e.Parameters ?? string.Empty, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Saving_again_replaces_the_one_credential_for_that_registry_and_removing_needs_the_step_up_too()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Owner);
        await StepUpAsync(kit);

        var first = await SaveAsync(kit);
        var second = await SaveAsync(kit, new SaveRegistryCredentialRequest("ghcr.io", "robot", "ghp_anotherTokenForTheSameRegistry0123"));
        await kit.Hub.InvokeAsync(nameof(ICoreHub.DeleteRegistryCredential), second.Id, Cancel);

        Assert.Equal(first.Id, second.Id);
        Assert.Equal("robot", second.Username);
        Assert.Empty(await ListAsync(kit));
        var missing = await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync(nameof(ICoreHub.DeleteRegistryCredential), second.Id, Cancel));
        Assert.Contains("no such credential", missing.Message, StringComparison.Ordinal);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "registry.credential-delete" && e.Target == "ghcr.io");
    }

    [Fact]
    public async Task Operators_see_which_registries_have_one_but_cannot_store_or_remove()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Operator);
        await StepUpAsync(kit);

        Assert.Empty(await ListAsync(kit));
        await Assert.ThrowsAsync<HubException>(() => SaveAsync(kit));
        await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync(nameof(ICoreHub.DeleteRegistryCredential), Guid.NewGuid(), Cancel));
    }

    [Fact]
    public async Task Viewers_do_not_even_see_the_list()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Viewer);

        await Assert.ThrowsAsync<HubException>(() => ListAsync(kit));
    }

    [Fact]
    public async Task A_bad_credential_is_refused_and_audited()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Admin);
        await StepUpAsync(kit);

        var refused = await Assert.ThrowsAsync<HubException>(() => SaveAsync(kit, new SaveRegistryCredentialRequest("ghcr.io/org", "user", Token)));

        Assert.Contains("registry host", refused.Message, StringComparison.Ordinal);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "registry.credential-save" && e.Result == "denied");
    }

    [Fact]
    public async Task The_raw_row_is_sealed_and_unreadable_without_the_cores_keys()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Admin);
        await StepUpAsync(kit);
        await SaveAsync(kit);

        var row = await RawRowAsync(kit);
        var sealedBytes = Convert.FromBase64String(row.SealedSecret);
        var elsewhere = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(kit.DataDirectory, "other-keys"))).CreateProtector(RegistryCredentials.Purpose);
        var ours = kit.Harness.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector(RegistryCredentials.Purpose);

        Assert.DoesNotContain(Token, row.SealedSecret, StringComparison.Ordinal);
        Assert.True(sealedBytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(Token)) < 0);
        Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(() => elsewhere.Unprotect(sealedBytes));
        Assert.Equal(Token, Encoding.UTF8.GetString(ours.Unprotect(sealedBytes)));
        Assert.Empty(RegistryDeployTests.FilesHoldingTheToken(kit));
    }

    [Fact]
    public async Task A_deploy_without_sign_ins_uses_the_stored_credential_and_wipes_it_afterwards()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Admin);
        await StepUpAsync(kit);
        await SaveAsync(kit);
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(RegistryDeployTests.Compose));

        var (job, log) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Contains(log, line => line.Text.Contains("with the credential stored on this server", StringComparison.Ordinal));
        var pull = Assert.Single(kit.Simulated.DockerConfigs, entry => entry.Command == "pull");
        Assert.Contains(RegistryDeployTests.Forms[1], pull.Config, StringComparison.Ordinal);
        Assert.False(Directory.Exists(pull.Folder));
        Assert.Empty(RegistryDeployTests.FilesHoldingTheToken(kit));
        Assert.All(log, line => Assert.DoesNotContain(Token, line.Text, StringComparison.Ordinal));
        Assert.NotNull(Assert.Single(await ListAsync(kit)).LastUsedAtUnixMs);
    }

    [Fact]
    public async Task A_stack_that_pulls_nothing_private_does_not_unseal_anything()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Admin);
        await StepUpAsync(kit);
        await SaveAsync(kit);
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload());

        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.All(kit.Simulated.DockerConfigs, entry => Assert.Null(entry.Folder));
        Assert.Null(Assert.Single(await ListAsync(kit)).LastUsedAtUnixMs);
    }

    [Fact]
    public async Task An_image_pull_on_the_containers_screen_signs_in_with_what_was_sent_or_what_is_stored()
    {
        await using var kit = await RegistryDeployTests.KitAsync(CoreRoles.Admin);
        var engine = kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>();
        engine.Tick = TimeSpan.Zero;
        const string Image = "ghcr.io/acme/private-web:1.0";

        var refused = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.PullImage), new ImagePullRequest(Image), Cancel));
        var sent = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(
            nameof(ICoreHub.PullImage),
            new ImagePullRequest(Image, new RegistryAuth("ghcr.io", RegistryDeployTests.User, Token)),
            Cancel));
        await StepUpAsync(kit);
        await SaveAsync(kit);
        var stored = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.PullImage), new ImagePullRequest(Image), Cancel));
        var wrongRegistry = await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync<JobInfo>(
            nameof(ICoreHub.PullImage),
            new ImagePullRequest(Image, new RegistryAuth("docker.io", RegistryDeployTests.User, Token)),
            Cancel));

        Assert.Equal(JobState.Failed, refused.Job.State);
        Assert.Contains(refused.Log, line => line.Text.Contains("unauthorized", StringComparison.Ordinal));
        Assert.Equal(JobState.Succeeded, sent.Job.State);
        Assert.Contains(sent.Log, line => line.Text.Contains("with the sign-in this pull brought", StringComparison.Ordinal));
        Assert.Equal(JobState.Succeeded, stored.Job.State);
        Assert.Contains(stored.Log, line => line.Text.Contains("stored on this server", StringComparison.Ordinal));
        Assert.Contains("not valid for the image's registry", wrongRegistry.Message, StringComparison.Ordinal);
        Assert.All(sent.Log.Concat(stored.Log), line => Assert.DoesNotContain(Token, line.Text, StringComparison.Ordinal));
        Assert.Empty(RegistryDeployTests.FilesHoldingTheToken(kit));
    }
}
