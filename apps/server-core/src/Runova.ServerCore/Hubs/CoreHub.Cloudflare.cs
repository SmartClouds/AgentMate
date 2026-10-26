using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Cloudflare on the server (E14). Every role reads the origin lock and which zones have a DNS
/// token; Admins change the lock (a firewall change set, so the lockout guard and the confirm
/// window apply as for any other), handle Origin CA certificates and send or remove DNS tokens.
/// The audit trail gets every change without request bodies: no token or certificate lands there.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<OriginLockStatus> GetOriginLock() => cloudflare.OriginLock.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginLockPreview> PreviewOriginLock(OriginLockRequest request)
    {
        try
        {
            return await cloudflare.OriginLock.PreviewAsync(request, await FirewallCallerAsync(), Context.ConnectionAborted);
        }
        catch (Exception error) when (error is FirewallRefusedException or ArgumentException)
        {
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginLockResult> ApplyOriginLock(OriginLockRequest request)
    {
        var caller = await FirewallCallerAsync();
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = request?.Enabled == true ? "true" : "false",
            ["authenticatedOriginPulls"] = request?.AuthenticatedOriginPulls == true ? "true" : "false",
        };
        try
        {
            var result = await cloudflare.OriginLock.ApplyAsync(request, caller, Caller, Context.ConnectionAborted);
            await AuditAsync("cloudflare.origin-lock", AuditResult.Success, result.ChangeSet?.Id.ToString("D"), FirewallParameters(caller, parameters));
            return result;
        }
        catch (Exception error) when (error is FirewallRefusedException or ArgumentException)
        {
            parameters["reason"] = error.Message;
            await AuditAsync(
                "cloudflare.origin-lock",
                error is FirewallRefusedException { Verdict: not null } or FirewallRefusedException { NeedsStepUp: true } ? AuditResult.Denied : AuditResult.Failed,
                null,
                FirewallParameters(caller, parameters));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginLockStatus> RefreshCloudflareRanges()
    {
        var status = await cloudflare.OriginLock.RefreshAsync(Context.ConnectionAborted);
        await AuditAsync("cloudflare.refresh-ranges", status.LastRefreshError is null ? AuditResult.Success : AuditResult.Failed, status.ChangeSetId?.ToString("D"));
        return status;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginCertificateRequestInfo> CreateOriginCertificateRequest(string siteId)
    {
        try
        {
            var request = await cloudflare.OriginCertificates.CreateRequestAsync(siteId, Context.ConnectionAborted);
            await AuditAsync("certificate.origin-request", AuditResult.Success, Target(siteId));
            return request;
        }
        catch (ArgumentException error)
        {
            await AuditAsync("certificate.origin-request", AuditResult.Failed, Target(siteId));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<CertificateUploadResult> InstallOriginCertificate(OriginCertificateInstall request)
    {
        try
        {
            var result = await cloudflare.OriginCertificates.InstallAsync(request, Caller, Context.ConnectionAborted);
            await AuditSaveAsync("certificate.origin-install", request?.SiteId, result.Problems.Length);
            return result;
        }
        catch (ArgumentException error)
        {
            await AuditAsync("certificate.origin-install", AuditResult.Failed, Target(request?.SiteId));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<DnsCredentialInfo[]> ListDnsCredentials() => cloudflare.DnsCredentials.ListAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<DnsCredentialSaveResult> SaveDnsCredential(DnsCredentialRequest request)
    {
        var result = await cloudflare.DnsCredentials.SaveAsync(request, Caller, Context.ConnectionAborted);
        await AuditAsync(
            "cloudflare.dns-token.save",
            result.Problems.Length == 0 ? AuditResult.Success : AuditResult.Failed,
            result.Credential?.Zone);
        return result;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task RemoveDnsCredential(string zone)
    {
        var removed = await cloudflare.DnsCredentials.RemoveAsync(zone, Context.ConnectionAborted);
        await AuditAsync("cloudflare.dns-token.remove", removed ? AuditResult.Success : AuditResult.Failed, removed ? zone.Trim().ToLowerInvariant() : null);
        if (!removed)
        {
            throw new HubException("This server has no DNS token for that zone.");
        }
    }
}
