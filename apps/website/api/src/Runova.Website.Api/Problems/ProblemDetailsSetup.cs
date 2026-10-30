namespace Runova.Website.Api.Problems;

internal static class ProblemDetailsSetup
{
    /// <summary>Problem details for every error, written by <see cref="ProblemJsonWriter"/>.</summary>
    public static IServiceCollection AddWebsiteProblemDetails(this IServiceCollection services)
    {
        services.AddSingleton<IProblemDetailsWriter, ProblemJsonWriter>();
        return services.AddProblemDetails();
    }

    /// <summary>
    /// Unhandled exceptions answer <c>internal</c> with no detail (Development keeps the developer
    /// page), and an empty error response, such as a 404 for an unknown route or a 405, gets a
    /// problem details body.
    /// </summary>
    public static WebApplication UseWebsiteProblemDetails(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment())
        {
            app.UseExceptionHandler();
        }

        app.UseStatusCodePages();
        return app;
    }
}
