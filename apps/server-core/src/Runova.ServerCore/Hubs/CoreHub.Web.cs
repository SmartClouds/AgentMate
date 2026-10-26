using System.Globalization;
using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Websites, stream proxies and certificates (E10, E11). Every role reads them; Admins change
/// sites, apply, and manage certificates; custom snippets are the Owner's alone, since they reach
/// nginx's configuration most directly. Taking a certificate off needs a step-up. Every change is
/// audited, refused ones included, without request bodies (passwords and keys never reach it).
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<NginxStatus> GetNginxStatus() => web.Sites.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<SiteInfo[]> ListSites() => web.Sites.ListSitesAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<StreamProxyInfo[]> ListStreamProxies() => web.Sites.ListStreamsAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<CertificateInfo[]> ListCertificates() => web.Certificates.ListAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<SiteLogBatch> StreamSiteLog(
        SiteLogRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = web.Streams.Open(Context.ConnectionId, StreamLimits.SiteLog);
        if (request is null || !Enum.IsDefined(request.Kind) || !NginxValidator.IsId(request.SiteId)
            || await web.Sites.GetSiteAsync(request.SiteId, cancellationToken) is null)
        {
            throw new HubException("There is no such site.");
        }

        var (_, layout) = await web.Sites.InspectAsync(cancellationToken);
        await foreach (var batch in web.Logs.StreamAsync(SiteLogs.PathOf(layout, request.SiteId, request.Kind), request.TailLines, request.Follow, cancellationToken))
        {
            yield return batch;
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<JobInfo> InstallNginx() =>
        StartJobAsync("nginx.install", () => web.Jobs.InstallNginxAsync(Caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<SiteSaveResult> SaveSite(SiteSettings settings)
    {
        var result = await web.Sites.SaveSiteAsync(settings, Context.ConnectionAborted);
        await AuditSaveAsync("site.save", settings?.Id, result.Problems.Length);
        return result;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<SiteSaveResult> SetSiteSnippets(SiteSnippets snippets)
    {
        var result = await web.Sites.SetSnippetsAsync(snippets, Context.ConnectionAborted);
        await AuditSaveAsync("site.snippets", snippets?.SiteId, result.Problems.Length);
        return result;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task DeleteSite(string siteId)
    {
        var deleted = await web.Sites.DeleteSiteAsync(siteId, Context.ConnectionAborted);
        await AuditAsync("site.delete", deleted ? AuditResult.Success : AuditResult.Failed, Target(siteId));
        if (!deleted)
        {
            throw new HubException("There is no such site.");
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<StreamProxySaveResult> SaveStreamProxy(StreamProxySettings settings)
    {
        var result = await web.Sites.SaveStreamAsync(settings, Context.ConnectionAborted);
        await AuditSaveAsync("stream-proxy.save", settings?.Id, result.Problems.Length);
        return result;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task DeleteStreamProxy(string proxyId)
    {
        var deleted = await web.Sites.DeleteStreamAsync(proxyId, Context.ConnectionAborted);
        await AuditAsync("stream-proxy.delete", deleted ? AuditResult.Success : AuditResult.Failed, Target(proxyId));
        if (!deleted)
        {
            throw new HubException("There is no such stream proxy.");
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<NginxApplyResult> ApplyNginx()
    {
        var result = await web.Sites.ApplyAsync(Caller, Context.ConnectionAborted);
        await AuditApplyAsync("nginx.apply", result);
        return result;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<JobInfo> IssueCertificate(CertificateIssueRequest request) =>
        StartCertificateJobAsync("certificate.issue", request?.SiteId, () => web.Certificates.StartIssueAsync(request!, Caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<JobInfo> RenewCertificate(string siteId) =>
        StartCertificateJobAsync("certificate.renew", siteId, () => web.Certificates.StartRenewAsync(siteId, Caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<CertificateUploadResult> UploadCertificate(CertificateUploadRequest request)
    {
        try
        {
            var result = await web.Certificates.UploadAsync(request!, Caller, Context.ConnectionAborted);
            await AuditSaveAsync("certificate.upload", request?.SiteId, result.Problems.Length);
            return result;
        }
        catch (ArgumentException error)
        {
            await AuditAsync("certificate.upload", AuditResult.Failed, Target(request?.SiteId));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<NginxApplyResult> RemoveCertificate(CertificateRemoveRequest request)
    {
        var parameters = new Dictionary<string, string?> { ["revoke"] = request?.Revoke == true ? "true" : "false" };
        try
        {
            var result = await web.Certificates.RemoveAsync(request!, Caller, Context.ConnectionAborted);
            await AuditAsync("certificate.remove", AuditResult.Success, Target(request?.SiteId), parameters);
            return result;
        }
        catch (Exception error) when (error is ArgumentException or Certificates.Acme.AcmeException or HttpRequestException)
        {
            await AuditAsync("certificate.remove", AuditResult.Failed, Target(request?.SiteId), parameters);
            throw new HubException(error is ArgumentException ? error.Message : Certificates.CertificateService.Describe(error));
        }
    }

    private async Task<JobInfo> StartCertificateJobAsync(string action, string? siteId, Func<Task<JobInfo>> start)
    {
        try
        {
            return await StartJobAsync(action, start, new() { ["site"] = Target(siteId) });
        }
        catch (ArgumentException error)
        {
            await AuditAsync(action, AuditResult.Failed, Target(siteId));
            throw new HubException(error.Message);
        }
    }

    private Task AuditSaveAsync(string action, string? id, int problems) =>
        AuditAsync(
            action,
            problems == 0 ? AuditResult.Success : AuditResult.Failed,
            Target(id),
            problems == 0 ? null : new() { ["problems"] = problems.ToString(CultureInfo.InvariantCulture) });

    private Task AuditApplyAsync(string action, NginxApplyResult result) =>
        AuditAsync(
            action,
            result.Applied ? AuditResult.Success : AuditResult.Failed,
            result.Release?.ToString(CultureInfo.InvariantCulture),
            new() { ["problems"] = result.Problems.Length.ToString(CultureInfo.InvariantCulture) });

    /// <summary>An id as the audit trail shows it: only when it is one, so request text never lands there.</summary>
    private static string? Target(string? id) => NginxValidator.IsId(id) ? id : null;
}
