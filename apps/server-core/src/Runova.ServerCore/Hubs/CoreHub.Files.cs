using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Files;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Files in a container or a volume (E27), Admin only, like the console: whoever can write a
/// container's files can run anything in it. Every refusal reaches the app as "[files:code]
/// sentence", and opening, new folders, renames, deletes and mode changes land in the audit
/// trail, refused ones included. Downloads and uploads are REST (FileEndpoints) and audited there.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<FileSessionInfo> FilesOpen(FileTarget target)
    {
        var described = target is null ? null : $"{(target.Kind == FileTargetKind.Volume ? "volume" : "container")}:{Clip(target.Id)}";
        try
        {
            var session = await files.OpenAsync(target!, UserId, Context.ConnectionAborted);
            await AuditAsync("files.open", AuditResult.Success, described, new() { ["session"] = session.SessionId.ToString("D") });
            return session;
        }
        catch (FileOperationException error)
        {
            await AuditAsync("files.open", ResultOf(error), described, new() { ["error"] = error.CodeName });
            throw new HubException(error.Coded);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesClose(Guid sessionId) => FileCallAsync(() => files.CloseAsync(sessionId, UserId, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<FileListing> FilesList(FilePathRequest request) =>
        FileCallAsync(() => files.ListAsync(Need(request).SessionId, UserId, request.Path, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<FileEntry?> FilesStat(FilePathRequest request) =>
        FileCallAsync(() => files.StatAsync(Need(request).SessionId, UserId, request.Path, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<string> FilesRealpath(FilePathRequest request) =>
        FileCallAsync(() => files.RealpathAsync(Need(request).SessionId, UserId, request.Path, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesMkdir(FilePathRequest request) =>
        FileChangeAsync(
            "files.mkdir",
            request?.SessionId,
            new() { ["path"] = Clip(request?.Path, 1024) },
            () => files.MkdirAsync(request!.SessionId, UserId, request.Path, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesRename(FileRenameRequest request) =>
        FileChangeAsync(
            "files.rename",
            request?.SessionId,
            new() { ["path"] = Clip(request?.From, 1024), ["to"] = Clip(request?.To, 1024) },
            () => files.RenameAsync(request!.SessionId, UserId, request.From, request.To, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesRemove(FileRemoveRequest request) =>
        FileChangeAsync(
            "files.remove",
            request?.SessionId,
            new() { ["path"] = Clip(request?.Path, 1024), ["directory"] = request?.Directory == true ? "true" : "false" },
            () => files.RemoveAsync(request!.SessionId, UserId, request.Path, request.Directory, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesChmod(FileChmodRequest request) =>
        FileChangeAsync(
            "files.chmod",
            request?.SessionId,
            new() { ["path"] = Clip(request?.Path, 1024), ["mode"] = request is null ? null : Convert.ToString(request.Mode, 8) },
            () => files.ChmodAsync(request!.SessionId, UserId, request.Path, request.Mode, Context.ConnectionAborted));

    private static string ResultOf(FileOperationException error) =>
        error.Code is FileErrorCode.InvalidInput or FileErrorCode.SessionGone or FileErrorCode.Unsupported or FileErrorCode.PermissionDenied
            ? AuditResult.Denied
            : AuditResult.Failed;

    private static string? Clip(string? value, int length) => value is not null && value.Length > length ? value[..length] : value;

    private static async Task FileCallAsync(Func<Task> call) => await FileCallAsync(async () =>
    {
        await call();
        return true;
    });

    private static async Task<T> FileCallAsync<T>(Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (FileOperationException error)
        {
            throw new HubException(error.Coded);
        }
    }

    private static T Need<T>([System.Diagnostics.CodeAnalysis.NotNull] T? request)
        where T : class =>
        request ?? throw new FileOperationException(FileErrorCode.InvalidInput, "The request is missing what it needs.");

    /// <summary>A change, recorded either way: the session's target, the paths, and the code when it was refused.</summary>
    private async Task FileChangeAsync(string action, Guid? sessionId, Dictionary<string, string?> parameters, Func<Task> change)
    {
        var target = sessionId is Guid id ? files.Describe(id) : null;
        try
        {
            if (sessionId is null)
            {
                throw new FileOperationException(FileErrorCode.InvalidInput, "The request is missing what it needs.");
            }

            await change();
        }
        catch (FileOperationException error)
        {
            parameters["error"] = error.CodeName;
            await AuditAsync(action, ResultOf(error), target, parameters);
            throw new HubException(error.Coded);
        }
        catch (OperationCanceledException)
        {
            await AuditAsync(action, AuditResult.Cancelled, target, parameters);
            throw;
        }

        parameters["session"] = sessionId.Value.ToString("D", CultureInfo.InvariantCulture);
        await AuditAsync(action, AuditResult.Success, target, parameters);
    }
}
