using System.Data.Common;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Data;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Counts the commands <see cref="AppDbContext"/> sends that change data, for a test that expects none.</summary>
internal sealed partial class DatabaseWrites : DbCommandInterceptor
{
    private int _count;

    public int Count => Volatile.Read(ref _count);

    public void Register(IServiceCollection services) =>
        services.ConfigureDbContext<AppDbContext>(options => options.AddInterceptors(this));

    // EF Core sends an insert with RETURNING as a reader, so both kinds of command are looked at.
    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        Note(command);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        Note(command);
        return base.NonQueryExecutingAsync(command, eventData, result, cancellationToken);
    }

    private void Note(DbCommand command)
    {
        if (Write().IsMatch(command.CommandText))
        {
            Interlocked.Increment(ref _count);
        }
    }

    [GeneratedRegex(@"\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Write();
}
