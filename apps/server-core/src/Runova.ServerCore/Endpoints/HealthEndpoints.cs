using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Endpoints;

internal static class HealthEndpoints
{
    public const string Path = "/api/v1/health";

    /// <summary>
    /// The only anonymous route: the installer and the app's first connection check need to know
    /// which core is running before anyone has signed in.
    /// </summary>
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints
            .MapGet(Path, (CoreStartup startup, CoreLayout layout, LayoutMigrationJournalFile journal, NameMovesFile moves) => TypedResults.Ok(
                new HealthResponse(
                    "ok",
                    CoreVersion.Current,
                    CoreVersion.ApiVersion,
                    startup.StartedAtUnixMs,
                    layout.Kind == CoreLayoutKind.Runova ? CoreLayoutName.Runova : CoreLayoutName.Legacy,
                    layout.Kind == CoreLayoutKind.Legacy ? journal.RolledBackError() : null,
                    layout.Kind == CoreLayoutKind.Runova ? moves.NginxError() : null)))
            .AllowAnonymous();
        return endpoints;
    }
}
