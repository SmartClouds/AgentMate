using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Private registries (E08). Operators deploy with sign-ins the app sends and see which registries
/// have a stored credential; storing or removing one is for Admins with a recent step-up, since a
/// stored credential lets anyone who can deploy pull with it. Nothing here returns a secret.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Operator)]
    public Task<JobInfo> DeployStackWithRegistries(StackDeployRequest request) =>
        StackCallAsync(() => stacks.DeployAsync(
            Required(request).StackId,
            request.Revision,
            request.Registries,
            StackCaller,
            Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<JobInfo> RollbackStackWithRegistries(StackDeployRequest request) =>
        StackCallAsync(() => stacks.RollbackAsync(
            Required(request).StackId,
            request.Revision,
            request.Registries,
            StackCaller,
            Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<RegistryCredentialInfo[]> ListRegistryCredentials() =>
        registries.ListAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public Task<RegistryCredentialInfo> SaveRegistryCredential(SaveRegistryCredentialRequest request) =>
        RegistryCallAsync(() => registries.SaveAsync(request, StackCaller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public Task DeleteRegistryCredential(Guid credentialId) =>
        RegistryCallAsync(async () =>
        {
            await registries.DeleteAsync(credentialId, StackCaller, Context.ConnectionAborted);
            return true;
        });

    private static StackDeployRequest Required(StackDeployRequest? request) =>
        request ?? throw new HubException("Name the app and the revision.");

    private static async Task<T> RegistryCallAsync<T>(Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (RegistryRefusedException refused)
        {
            throw new HubException(refused.Message);
        }
    }
}
