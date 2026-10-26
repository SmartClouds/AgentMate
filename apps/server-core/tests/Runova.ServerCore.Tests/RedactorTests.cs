using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// One redactor runs before anything is stored or streamed: audit parameters, job logs and alert
/// messages. It knows secret-like names, the shapes of well-known credentials, and any exact values
/// a caller seeds it with (a stack's env values, a token handed to one job).
/// </summary>
public sealed class RedactorTests
{
    private static readonly Redactor _redactor = new();

    [Theory]
    [InlineData("ghp_abcdefghijklmnopqrstuvwxyz0123456789")]
    [InlineData("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz")]
    [InlineData("glpat-abcdefghij0123456789")]
    [InlineData("AKIAIOSFODNN7EXAMPLE")]
    [InlineData("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")]
    [InlineData("xoxb-1234567890-abcdefghijkl")]
    [InlineData("sk_live_abcdefghijklmnop1234")]
    [InlineData("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")]
    [InlineData("AIzaSyA-abcdefghijklmnopqrstuvwxyz01234")]
    [InlineData("npm_abcdefghijklmnopqrstuvwxyz0123456789")]
    [InlineData("dckr_pat_abcdefghijklmnopqrstuvwx")]
    public void Well_known_credentials_are_masked_wherever_they_appear(string credential)
    {
        var text = $"pulling with {credential} now";

        var redacted = _redactor.Redact(text);

        Assert.DoesNotContain(credential, redacted, StringComparison.Ordinal);
        Assert.StartsWith("pulling with ", redacted, StringComparison.Ordinal);
        Assert.EndsWith(" now", redacted, StringComparison.Ordinal);
        Assert.Contains(Redactor.Mask, redacted, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("DB_PASSWORD=hunter2-hunter2", "hunter2-hunter2")]
    [InlineData("export API_KEY='abc 123'", "abc 123")]
    [InlineData("\"client_secret\": \"s3cr3t-value\"", "s3cr3t-value")]
    [InlineData("mysql --password=topsecret123 -u root", "topsecret123")]
    [InlineData("docker login --password topsecret123 registry", "topsecret123")]
    [InlineData("Authorization: Bearer abc.def.ghi", "abc.def.ghi")]
    [InlineData("curl -H 'Authorization: Basic dXNlcjpwYXNz' https://x", "dXNlcjpwYXNz")]
    [InlineData("fetch https://deploy:tok3n-value@git.example.com/repo.git", "tok3n-value")]
    public void Values_next_to_secret_names_are_masked(string text, string secret)
    {
        var redacted = _redactor.Redact(text);

        Assert.DoesNotContain(secret, redacted, StringComparison.Ordinal);
        Assert.Contains(Redactor.Mask, redacted, StringComparison.Ordinal);
    }

    [Fact]
    public void A_url_keeps_its_user_and_host_but_not_its_password()
    {
        var redacted = _redactor.Redact("fetch https://deploy:tok3n-value@git.example.com/repo.git");

        Assert.Equal("fetch https://deploy:[redacted]@git.example.com/repo.git", redacted);
    }

    [Theory]
    [InlineData("Reading package lists... Done")]
    [InlineData("Setting up keyboard-configuration (1.205ubuntu3) ...")]
    [InlineData("Get:1 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]")]
    [InlineData("openssl-libs.x86_64    1:3.0.7-27.el9    baseos")]
    [InlineData("Unpacking libssl3t64:amd64 (3.0.13-0ubuntu3.4) over (3.0.13-0ubuntu3.1) ...")]
    [InlineData("The task-runner finished in 3s")]
    public void Ordinary_output_is_left_alone(string line)
    {
        Assert.Equal(line, _redactor.Redact(line));
    }

    [Fact]
    public void Seeded_values_are_masked_exactly()
    {
        var redactor = _redactor.With(["correct-horse-battery", "tiny", null, "   "]);

        var redacted = redactor.Redact("connecting with correct-horse-battery and a tiny detail");

        Assert.Equal("connecting with [redacted] and a [redacted] detail", redacted);
        // The seeds belong to the derived redactor only.
        Assert.Contains("correct-horse-battery", _redactor.Redact("correct-horse-battery"), StringComparison.Ordinal);
    }

    [Fact]
    public void Values_too_short_to_be_secrets_are_not_seeded()
    {
        var redactor = _redactor.With(["yes", "1"]);

        Assert.Equal("yes, 1 package", redactor.Redact("yes, 1 package"));
    }

    [Fact]
    public void A_private_key_block_is_masked_whole()
    {
        var text = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\nafter";

        var redacted = _redactor.Redact(text);

        Assert.Equal("before\n[redacted]\nafter", redacted);
    }

    [Fact]
    public void Log_lines_inside_a_private_key_block_are_masked_until_it_ends()
    {
        var lines = new LineRedactor(_redactor);

        string[] output =
        [
            lines.Redact("key follows"),
            lines.Redact("-----BEGIN RSA PRIVATE KEY-----"),
            lines.Redact("MIIEowIBAAKCAQEAuM8Cz4Z2Vt0zQk"),
            lines.Redact("-----END RSA PRIVATE KEY-----"),
            lines.Redact("done"),
        ];

        Assert.Equal(["key follows", Redactor.Mask, Redactor.Mask, Redactor.Mask, "done"], output);
    }

    [Fact]
    public void Parameters_with_secret_names_or_values_never_reach_the_stored_text()
    {
        var stored = _redactor.With(["seeded-value-123"]).Serialize(new Dictionary<string, string?>
        {
            ["userName"] = "owner",
            ["password"] = "correct horse",
            ["totpCode"] = "123456",
            ["registry"] = "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            ["note"] = "uses seeded-value-123",
        });

        Assert.NotNull(stored);
        Assert.Contains("owner", stored, StringComparison.Ordinal);
        foreach (var secret in new[] { "correct horse", "123456", "ghp_abcdefghij", "seeded-value-123" })
        {
            Assert.DoesNotContain(secret, stored, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void No_parameters_store_nothing()
    {
        Assert.Null(_redactor.Serialize(null));
        Assert.Null(_redactor.Serialize(new Dictionary<string, string?>()));
    }

    [Theory]
    [InlineData("password", true)]
    [InlineData("newPassword", true)]
    [InlineData("apiKey", true)]
    [InlineData("client_secret", true)]
    [InlineData("recoveryCode", true)]
    [InlineData("userName", false)]
    [InlineData("deviceName", false)]
    [InlineData("securityOnly", false)]
    public void Secret_names_are_recognised_in_any_case(string name, bool secret)
    {
        Assert.Equal(secret, Redactor.IsSecretName(name));
    }
}
