using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// The API in memory, pointed at a test database. Production unless a test says otherwise; a test
/// may also hand it a fake clock or ask it to migrate the database on start.
/// </summary>
public sealed class WebsiteApiFactory(
    string connectionString,
    string environment = "Production",
    TimeProvider? time = null,
    bool migrateOnStart = false)
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

        if (time is not null)
        {
            builder.ConfigureTestServices(services => services.AddSingleton(time));
        }
    }

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
