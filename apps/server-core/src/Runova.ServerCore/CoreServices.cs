using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore;

/// <summary>
/// Everything that reads or writes the core's state: the database, Identity, the encryption keys,
/// the audit trail and the redactor it runs everything through. The web host and the admin commands both register it, so they always see
/// the same data and can read each other's encrypted values.
/// </summary>
internal static class CoreServices
{
    /// <param name="dataDirectory">The state folder, resolved when first needed.</param>
    public static IServiceCollection AddCoreData(
        this IServiceCollection services,
        Func<IServiceProvider, string> dataDirectory)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(dataDirectory);
        services.TryAddSingleton(TimeProvider.System);

        // On Linux there is no OS key store to wrap the keys with; the state folder's root-only
        // permissions are what protect them.
        services.AddDataProtection().SetApplicationName(FrozenIdentifiers.DataProtectionApplicationName);
        services
            .AddOptions<KeyManagementOptions>()
            .Configure<IServiceProvider>((options, provider) =>
            {
                var keys = Path.Combine(dataDirectory(provider), "keys");
                options.XmlRepository = new FileSystemXmlRepository(
                    new DirectoryInfo(keys),
                    provider.GetRequiredService<ILoggerFactory>());
            });

        services.AddDbContextFactory<CoreDbContext>((provider, options) =>
            CoreDatabase.Configure(options, CoreDatabase.PathIn(dataDirectory(provider))));
        services.AddScoped(provider =>
            provider.GetRequiredService<IDbContextFactory<CoreDbContext>>().CreateDbContext());

        services
            .AddIdentityCore<CoreUser>(CoreIdentity.Configure)
            .AddRoles<CoreRole>()
            .AddUserStore<ProtectedUserStore>()
            .AddRoleStore<RoleStore<CoreRole, CoreDbContext, Guid>>()
            .AddDefaultTokenProviders()
            // After the defaults, so it takes the authenticator's place instead of losing to it.
            .AddTokenProvider<OneTimeAuthenticatorTokenProvider>(TokenOptions.DefaultAuthenticatorProvider)
            .AddPasswordValidator<CommonPasswordValidator>();
        services.Configure<PasswordHasherOptions>(options => options.IterationCount = CoreIdentity.Pbkdf2Iterations);

        services.TryAddSingleton<Redactor>();
        services.AddSingleton<AuditLog>();
        return services;
    }

    /// <summary>Creates the roles on a new database. Safe to call on every start.</summary>
    public static async Task EnsureRolesAsync(RoleManager<CoreRole> roles)
    {
        ArgumentNullException.ThrowIfNull(roles);
        foreach (var name in CoreRoles.All)
        {
            if (!await roles.RoleExistsAsync(name))
            {
                var result = await roles.CreateAsync(new CoreRole { Name = name });
                if (!result.Succeeded)
                {
                    throw new InvalidOperationException($"Could not create the {name} role.");
                }
            }
        }
    }
}
