using Hangfire;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// The API in memory, pointed at a test database. Production unless a test says otherwise; a test
/// may also hand it a fake clock, ask it to migrate the database on start, add settings, or
/// replace services.
/// </summary>
public sealed class WebsiteApiFactory(
    string connectionString,
    string environment = "Production",
    TimeProvider? time = null,
    bool migrateOnStart = false,
    IReadOnlyDictionary<string, string>? settings = null,
    Action<IServiceCollection>? services = null)
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(environment);
        builder.UseSetting("ConnectionStrings:Default", connectionString);
        if (migrateOnStart)
        {
            builder.UseSetting("Database:MigrateOnStart", "true");
        }

        foreach (var (key, value) in settings ?? new Dictionary<string, string>())
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureTestServices(testServices =>
        {
            // No test needs jobs processed in the background, and a Hangfire server per test host
            // holds enough connections to run the database out of them.
            foreach (var server in testServices.Where(IsJobServer).ToList())
            {
                testServices.Remove(server);
            }

            if (time is not null)
            {
                testServices.AddSingleton(time);
            }

            services?.Invoke(testServices);
        });
    }

    private static bool IsJobServer(ServiceDescriptor service) =>
        service.ServiceType == typeof(IHostedService)
        && (service.ImplementationType ?? service.ImplementationFactory?.Method.ReturnType) == typeof(BackgroundJobServerHostedService);

    /// <summary>
    /// A client on https, since the session and antiforgery cookies are Secure, that keeps cookies
    /// and never follows a redirect.
    /// </summary>
    internal ApiClient CreateApiClient() =>
        new(CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            AllowAutoRedirect = false,
        }));
}
