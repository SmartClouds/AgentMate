using Runova.ServerCore.Backups;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>What each kind of destination needs before it is kept, and the one line a list shows for it.</summary>
public sealed class BackupDestinationRulesTests
{
    private static readonly string _hostKey = new('a', 64);

    private static string? Problem(BackupDestinationKind kind, BackupDestinationSettings settings, BackupDestinationSecret? secret, bool hasStoredSecret = false, string name = "Offsite") =>
        BackupDestinationRules.Problem(name, kind, settings, secret, hasStoredSecret, null);

    [Fact]
    public void A_folder_needs_an_absolute_path_away_from_the_system()
    {
        Assert.Null(Problem(BackupDestinationKind.Folder, new(Path: "/var/backups/runova"), null));
        Assert.NotNull(Problem(BackupDestinationKind.Folder, new(Path: "backups"), null));
        Assert.NotNull(Problem(BackupDestinationKind.Folder, new(Path: "/"), null));
        Assert.NotNull(Problem(BackupDestinationKind.Folder, new(Path: "/proc/backups"), null));
        Assert.NotNull(Problem(BackupDestinationKind.Folder, new(Path: "/var/backups/../../etc"), null));
    }

    [Fact]
    public void Ftp_needs_a_host_a_user_and_a_password_once()
    {
        var settings = new BackupDestinationSettings(Path: "/backups", Host: "backup.example.com", Port: 21, UserName: "deploy", Tls: true);

        Assert.Null(Problem(BackupDestinationKind.Ftp, settings, new(Password: "hunter22")));
        Assert.Null(Problem(BackupDestinationKind.Ftp, settings, null, hasStoredSecret: true));
        Assert.NotNull(Problem(BackupDestinationKind.Ftp, settings, null));
        Assert.NotNull(Problem(BackupDestinationKind.Ftp, settings with { Host = "bad host!" }, new(Password: "x")));
        Assert.NotNull(Problem(BackupDestinationKind.Ftp, settings with { Port = 70000 }, new(Password: "x")));
        Assert.NotNull(Problem(BackupDestinationKind.Ftp, settings with { UserName = null }, new(Password: "x")));
    }

    [Fact]
    public void Sftp_needs_a_key_or_password_and_a_pinned_host_key()
    {
        var settings = new BackupDestinationSettings(Path: "/home/deploy/backups", Host: "10.0.0.5", Port: 22, UserName: "deploy", HostKeySha256: _hostKey);

        Assert.Null(Problem(BackupDestinationKind.Sftp, settings, new(PrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----")));
        Assert.Null(Problem(BackupDestinationKind.Sftp, settings, new(Password: "hunter22")));
        Assert.NotNull(Problem(BackupDestinationKind.Sftp, settings with { HostKeySha256 = null }, new(Password: "x")));
        Assert.NotNull(Problem(BackupDestinationKind.Sftp, settings, new()));
    }

    [Theory]
    [InlineData(BackupDestinationKind.GoogleDrive)]
    [InlineData(BackupDestinationKind.OneDrive)]
    public void Cloud_drives_need_the_user_s_own_client_and_a_refresh_token(BackupDestinationKind kind)
    {
        var settings = new BackupDestinationSettings(ClientId: "1234-abc.apps.googleusercontent.com", FolderName: "Runova Backups");

        Assert.Null(Problem(kind, settings, new(RefreshToken: "1//token", ClientSecret: "secret")));
        Assert.NotNull(Problem(kind, settings with { ClientId = null }, new(RefreshToken: "1//token")));
        Assert.NotNull(Problem(kind, settings, new(ClientSecret: "secret")));
        Assert.NotNull(Problem(kind, settings with { FolderName = "a/b" }, new(RefreshToken: "1//token")));
    }

    [Fact]
    public void Telegram_needs_the_app_id_and_a_finished_sign_in()
    {
        var settings = new BackupDestinationSettings(ApiId: 123456, Chat: "me");

        Assert.Null(Problem(BackupDestinationKind.Telegram, settings, new(ApiHash: new string('b', 32), TelegramLoginId: "login-1")));
        Assert.NotNull(Problem(BackupDestinationKind.Telegram, settings with { ApiId = 0 }, new(ApiHash: new string('b', 32), TelegramLoginId: "login-1")));
        Assert.NotNull(Problem(BackupDestinationKind.Telegram, settings, new(ApiHash: "short", TelegramLoginId: "login-1")));
        Assert.NotNull(Problem(BackupDestinationKind.Telegram, settings, new(ApiHash: new string('b', 32))));
    }

    [Fact]
    public void A_name_and_a_part_size_have_limits()
    {
        var folder = new BackupDestinationSettings(Path: "/srv/backups");

        Assert.NotNull(Problem(BackupDestinationKind.Folder, folder, null, name: ""));
        Assert.NotNull(Problem(BackupDestinationKind.Folder, folder, null, name: new string('n', 101)));
        Assert.NotNull(BackupDestinationRules.Problem("Offsite", BackupDestinationKind.Folder, folder, null, false, 1000));
        Assert.Null(BackupDestinationRules.Problem("Offsite", BackupDestinationKind.Folder, folder, null, false, 64L * 1024 * 1024));
    }

    [Fact]
    public void Telegram_parts_follow_the_account_and_others_follow_the_setting()
    {
        Assert.Equal(2000L * 1024 * 1024, BackupDestinationRules.PartBytes(BackupDestinationKind.Telegram, new(IsPremium: false), null));
        Assert.Equal(4000L * 1024 * 1024, BackupDestinationRules.PartBytes(BackupDestinationKind.Telegram, new(IsPremium: true), 10L * 1024 * 1024 * 1024));
        Assert.Equal(1024L * 1024 * 1024, BackupDestinationRules.PartBytes(BackupDestinationKind.Telegram, new(IsPremium: true), 1024L * 1024 * 1024));
        Assert.Null(BackupDestinationRules.PartBytes(BackupDestinationKind.Sftp, new(), null));
        Assert.Equal(5L * 1024 * 1024, BackupDestinationRules.PartBytes(BackupDestinationKind.Ftp, new(), 5L * 1024 * 1024));
    }

    [Fact]
    public void Each_kind_reads_as_one_line()
    {
        Assert.Equal("/srv/backups", BackupDestinationRules.Summary(BackupDestinationKind.Folder, new(Path: "/srv/backups")));
        Assert.Equal("ftps://deploy@backup.example.com:21/backups", BackupDestinationRules.Summary(BackupDestinationKind.Ftp, new(Path: "/backups", Host: "backup.example.com", Port: 21, UserName: "deploy", Tls: true)));
        Assert.Equal("sftp://deploy@10.0.0.5:2222/b", BackupDestinationRules.Summary(BackupDestinationKind.Sftp, new(Path: "/b", Host: "10.0.0.5", Port: 2222, UserName: "deploy")));
        Assert.Equal("Google Drive, Runova Backups", BackupDestinationRules.Summary(BackupDestinationKind.GoogleDrive, new(FolderName: "Runova Backups")));
        Assert.Equal("OneDrive, Runova Backups", BackupDestinationRules.Summary(BackupDestinationKind.OneDrive, new()));
        Assert.Equal("Telegram, Saved Messages of Ada", BackupDestinationRules.Summary(BackupDestinationKind.Telegram, new(AccountName: "Ada", Chat: "me")));
    }
}
