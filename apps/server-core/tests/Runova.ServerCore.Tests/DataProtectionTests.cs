using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The core's encryption keys (for stored secrets, from E04 on) live in its own state folder,
/// which systemd creates for root only, never in root's home directory.
/// </summary>
public sealed class DataProtectionTests : IDisposable
{
    private readonly string _dataDirectory = Path.Combine(Path.GetTempPath(), $"core-data-{Guid.NewGuid():N}");

    [Fact]
    public void Keys_are_kept_in_the_core_data_folder()
    {
        using var factory = new CoreFactory().WithWebHostBuilder(builder =>
            builder.UseSetting("Core:DataDirectory", _dataDirectory));

        var protector = factory.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("test");
        var sealedText = protector.Protect("secret");

        Assert.Equal("secret", protector.Unprotect(sealedText));
        Assert.NotEmpty(Directory.GetFiles(Path.Combine(_dataDirectory, "keys"), "key-*.xml"));
    }

    [Fact]
    public void Linux_keeps_its_data_under_var_lib()
    {
        var configuration = new ConfigurationBuilder().Build();

        Assert.Equal("/var/lib/runova-core", CorePaths.DataDirectory(configuration, isLinux: true));
    }

    [Fact]
    public void A_configured_data_folder_wins()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection([new KeyValuePair<string, string?>("Core:DataDirectory", "/srv/core")])
            .Build();

        Assert.Equal("/srv/core", CorePaths.DataDirectory(configuration, isLinux: true));
    }

    public void Dispose()
    {
        TestFolders.Delete(_dataDirectory);
    }
}
