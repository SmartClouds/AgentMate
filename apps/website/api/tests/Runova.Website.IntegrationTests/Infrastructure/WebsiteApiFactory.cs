using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>The API in memory, pointed at a test database. Production unless a test says otherwise.</summary>
public sealed class WebsiteApiFactory(string connectionString, string environment = "Production")
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(environment);
        builder.UseSetting("ConnectionStrings:Default", connectionString);
    }
}
