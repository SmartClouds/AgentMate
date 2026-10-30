using Microsoft.EntityFrameworkCore;

namespace Runova.Website.Data;

/// <summary>The website's PostgreSQL database. Identity and the resources add their sets later.</summary>
public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options);
