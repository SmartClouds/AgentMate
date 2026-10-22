using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace AgentMate.ServerCore.Hubs;

/// <summary>
/// Files in a container or a volume (E27), Admin only, like the console: whoever can write a
/// container's files can run anything in it.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Admin)]
    public Task<FileSessionInfo> FilesOpen(FileTarget target) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesClose(Guid sessionId) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<FileListing> FilesList(FilePathRequest request) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<FileEntry?> FilesStat(FilePathRequest request) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<string> FilesRealpath(FilePathRequest request) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesMkdir(FilePathRequest request) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesRename(FileRenameRequest request) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesRemove(FileRemoveRequest request) => throw NotBuilt();

    [Authorize(Policy = CorePolicies.Admin)]
    public Task FilesChmod(FileChmodRequest request) => throw NotBuilt();

    // T0 scaffold: the service behind these comes in with its tests (E27 T4 and T5).
    private static HubException NotBuilt() => new("Files are not available on this core yet.");
}
