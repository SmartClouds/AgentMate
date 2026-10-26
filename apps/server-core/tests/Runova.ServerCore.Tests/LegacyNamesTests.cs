using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Files;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Security;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Tests;

/// <summary>
/// What still answers to the names from before the rename. The strings that feed encryption keys
/// are pinned here exactly: changing one would leave every secret in core.db and every backup
/// made so far unreadable.
/// </summary>
public sealed class LegacyNamesTests(CoreFactory factory) : IClassFixture<CoreFactory>
{
    [Fact]
    public void The_encryption_inputs_never_change()
    {
        Assert.Equal("agentmate-core", FrozenIdentifiers.DataProtectionApplicationName); // legacy-name
        Assert.Equal("AgentMate.Cloudflare.DnsToken.v1", FrozenIdentifiers.CloudflareDnsTokenPurpose); // legacy-name
        Assert.Equal("AgentMate.Backups.Destination.v1", FrozenIdentifiers.BackupDestinationPurpose); // legacy-name
        Assert.Equal("AgentMate.Certificates.PrivateKey.v1", FrozenIdentifiers.CertificatePrivateKeyPurpose); // legacy-name
        Assert.Equal("AgentMate.Acme.AccountKey.v1", FrozenIdentifiers.AcmeAccountKeyPurpose); // legacy-name
        Assert.Equal("AgentMate.Registries.Credential.v1", FrozenIdentifiers.RegistryCredentialPurpose); // legacy-name
        Assert.Equal("AgentMate.Notifications.Telegram.Token.v1", FrozenIdentifiers.TelegramTokenPurpose); // legacy-name
        Assert.Equal("AgentMate.ErrorReporting.Dsn.v1", FrozenIdentifiers.ErrorReportingDsnPurpose); // legacy-name
        Assert.Equal("agentmate-core.identity.second-factor", FrozenIdentifiers.SecondFactorPurpose); // legacy-name
        Assert.Equal("agentmate-core.access-token.v1", FrozenIdentifiers.AccessTokenPurpose); // legacy-name
        Assert.Equal("AgentMate backup content key v2", FrozenIdentifiers.BackupContentKeyLabel); // legacy-name
        Assert.Equal("AMBACKUP", FrozenIdentifiers.BackupMagic);
    }

    [Theory]
    [InlineData("runova-core")]
    [InlineData("agentmate-core")] // legacy-name
    public async Task The_core_answers_to_either_host_name(string host)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
        request.Headers.Host = host;

        using var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Health_names_the_layout()
    {
        using var client = factory.CreateClient();

        var health = await client.GetFromJsonAsync<HealthResponse>("/api/v1/health", CoreJson.Options, TestContext.Current.CancellationToken);

        Assert.Equal(CoreLayoutName.Runova, health!.Layout);
        Assert.Null(health.MigrationError);
    }

    [Theory]
    [InlineData("runova-core/auth/v1")]
    [InlineData("agentmate-core/auth/v1")] // legacy-name
    public void A_signature_under_either_prefix_signs_the_challenge(string prefix)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var challenge = Guid.NewGuid();
        var device = Guid.NewGuid();
        var signature = key.SignData(
            Encoding.UTF8.GetBytes(AuthMessage.For(AuthPurpose.Login, challenge, "n", device, null, prefix)),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

        Assert.True(AuthMessage.Verify(key.ExportSubjectPublicKeyInfo(), signature, AuthPurpose.Login, challenge, "n", device, null));
        Assert.False(AuthMessage.Verify(key.ExportSubjectPublicKeyInfo(), signature, AuthPurpose.Renew, challenge, "n", device, null));
    }

    [Fact]
    public void Exec_approvals_take_either_prefix()
    {
        Assert.Equal(["runova-core/exec/v1", "agentmate-core/exec/v1"], ExecApprovals.Prefixes); // legacy-name
        Assert.StartsWith(LegacyNames.ExecPrefix + "\n", ExecApprovals.Message(Guid.Empty, "n", Guid.Empty, Guid.Empty, "ls", LegacyNames.ExecPrefix), StringComparison.Ordinal);
    }

    [Fact]
    public void Backups_from_before_the_rename_are_still_listed()
    {
        Assert.True(BackupNaming.IsManifestName("agentmate-web-20261020-101010-0123abcd.manifest.json")); // legacy-name
        Assert.True(BackupNaming.IsManifestName("runova-web-20261020-101010-0123abcd.manifest.json"));
        Assert.False(BackupNaming.IsManifestName("other-web-20261020-101010-0123abcd.manifest.json"));
        Assert.Equal(".rnbackup", BackupNaming.Extension);
        Assert.Equal("runova-web.rnbackup", BackupNaming.PartName("runova-web", 1, 1));
    }

    [Fact]
    public void A_manifest_name_follows_from_a_part_under_either_extension()
    {
        static BackupManifestFile Manifest(string part) =>
            new(1, Guid.NewGuid(), null, "x", 0, 1, new string('a', 64), "1", "k", [new(1, part, 1, new string('a', 64))]);

        Assert.Equal("agentmate-web-1.manifest.json", FolderDestination.ManifestNameOf(Manifest("agentmate-web-1.ambackup"))); // legacy-name
        Assert.Equal("agentmate-web-1.manifest.json", FolderDestination.ManifestNameOf(Manifest("agentmate-web-1.ambackup.part002"))); // legacy-name
        Assert.Equal("runova-web-1.manifest.json", FolderDestination.ManifestNameOf(Manifest("runova-web-1.rnbackup")));
    }

    [Fact]
    public void A_revision_from_before_the_rename_keeps_its_override_file()
    {
        var folder = TestFolders.Create("override");
        Directory.CreateDirectory(folder);
        try
        {
            Assert.Equal(Path.Combine(folder, LoopbackOverride.FileName), LoopbackOverride.PathIn(folder));
            File.WriteAllText(Path.Combine(folder, LegacyNames.LoopbackOverrideFile), "services: {}\n");
            Assert.Equal(Path.Combine(folder, LegacyNames.LoopbackOverrideFile), LoopbackOverride.PathIn(folder));
            File.WriteAllText(Path.Combine(folder, LoopbackOverride.FileName), "services: {}\n");
            Assert.Equal(Path.Combine(folder, LoopbackOverride.FileName), LoopbackOverride.PathIn(folder));
        }
        finally
        {
            TestFolders.Delete(folder);
        }
    }

    [Fact]
    public void Helpers_from_before_the_rename_are_swept_too() =>
        Assert.Equal(["runova.files", "agentmate.files"], VolumeHelpers.Labels); // legacy-name

    [Fact]
    public void Units_from_before_the_rename_are_still_recognised() =>
        Assert.Equal(["runova-", "agentmate-"], CoreLayout.TransientUnitPrefixes); // legacy-name

    [Fact]
    public void A_second_core_on_the_same_state_stops()
    {
        var folder = TestFolders.Create("instance-lock");
        try
        {
            using (SingleInstanceLock.Acquire(folder))
            {
                var error = Assert.Throws<InvalidOperationException>(() => SingleInstanceLock.Acquire(folder));
                Assert.Contains("Another server core", error.Message, StringComparison.Ordinal);
            }

            // Released with the first, so a restart takes it again.
            SingleInstanceLock.Acquire(folder).Dispose();
        }
        finally
        {
            TestFolders.Delete(folder);
        }
    }
}
