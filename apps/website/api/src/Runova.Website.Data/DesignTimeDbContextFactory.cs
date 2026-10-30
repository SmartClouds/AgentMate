using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Runova.Website.Data;

/// <summary>
/// Lets <c>dotnet ef</c> build the model from this project alone. Adding a migration never
/// connects; <c>database update</c> takes <c>--connection</c>.
/// </summary>
internal sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseNpgsql("Host=localhost;Database=runova_website").Options);
}
