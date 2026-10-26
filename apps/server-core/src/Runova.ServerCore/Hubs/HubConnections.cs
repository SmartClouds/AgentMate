using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Open hub connections by user, session and device, so revoking one ends its live connections
/// too, not just its next sign-in. The connection that asked for the revocation closes a moment
/// later, once its answer has gone out.
/// </summary>
internal sealed class HubConnections
{
    private static readonly TimeSpan _callerGrace = TimeSpan.FromMilliseconds(250);

    private readonly ConcurrentDictionary<string, (Guid User, Guid Session, Guid Device, HubCallerContext Context)> _open = new();

    public void Add(HubCallerContext context, Guid sessionId, Guid deviceId)
    {
        ArgumentNullException.ThrowIfNull(context);
        var user = Guid.TryParse(context.User?.FindFirstValue(ClaimTypes.NameIdentifier), out var id) ? id : Guid.Empty;
        _open[context.ConnectionId] = (user, sessionId, deviceId, context);
    }

    public void Remove(string connectionId) => _open.TryRemove(connectionId, out _);

    public void CloseSession(Guid sessionId, string callerConnectionId) =>
        Close(entry => entry.Session == sessionId, callerConnectionId);

    public void CloseDevice(Guid deviceId, string callerConnectionId) =>
        Close(entry => entry.Device == deviceId, callerConnectionId);

    /// <summary>Every connection of one user: their rights changed, so they reconnect under the new ones.</summary>
    public void CloseUser(Guid userId, string callerConnectionId) =>
        Close(entry => entry.User == userId, callerConnectionId);

    /// <summary>Every open connection, at once: what a reboot does to them.</summary>
    public void CloseAll()
    {
        foreach (var (_, entry) in _open)
        {
            entry.Context.Abort();
        }
    }

    private void Close(Func<(Guid User, Guid Session, Guid Device), bool> matches, string callerConnectionId)
    {
        foreach (var (connectionId, entry) in _open)
        {
            if (!matches((entry.User, entry.Session, entry.Device)))
            {
                continue;
            }

            if (connectionId == callerConnectionId)
            {
                _ = CloseSoonAsync(entry.Context);
            }
            else
            {
                entry.Context.Abort();
            }
        }
    }

    private static async Task CloseSoonAsync(HubCallerContext context)
    {
        await Task.Delay(_callerGrace);
        context.Abort();
    }
}
