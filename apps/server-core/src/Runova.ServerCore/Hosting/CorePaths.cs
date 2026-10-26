namespace Runova.ServerCore.Hosting;

/// <summary>Where the core keeps its state on disk.</summary>
internal static class CorePaths
{
    /// <summary>systemd's StateDirectory for this core's layout: created for root only (0700) before the core starts.</summary>
    public static string LinuxDataDirectory => CoreLayout.Current.DataDirectory;

    public static string DataDirectory(IConfiguration configuration, bool isLinux)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var configured = configuration["Core:DataDirectory"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        return isLinux
            ? LinuxDataDirectory
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Runova",
                "ServerCore");
    }
}
