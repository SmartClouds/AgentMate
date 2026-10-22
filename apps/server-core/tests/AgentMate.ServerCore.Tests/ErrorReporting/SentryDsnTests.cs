using AgentMate.ServerCore.ErrorReporting;

namespace AgentMate.ServerCore.Tests.ErrorReporting;

/// <summary>
/// A DSN is the one string a person pastes to point the core at a Sentry project. These are the same
/// cases the app checks in TypeScript (errorReportingValidation.test.ts), so both sides agree.
/// </summary>
public sealed class SentryDsnTests
{
    private const string Key = "d4e5f60718293a4b5c6d7e8f90a1b2c3";

    [Theory]
    [InlineData($"https://{Key}@o123456.ingest.us.sentry.io/4501", "o123456.ingest.us.sentry.io", "4501", "https://o123456.ingest.us.sentry.io/api/4501/integration/otlp/v1/logs")]
    [InlineData($"https://{Key}@o9.ingest.de.sentry.io/77", "o9.ingest.de.sentry.io", "77", "https://o9.ingest.de.sentry.io/api/77/integration/otlp/v1/logs")]
    [InlineData($"https://{Key}@sentry.example.com:9000/12", "sentry.example.com:9000", "12", "https://sentry.example.com:9000/api/12/integration/otlp/v1/logs")]
    [InlineData($"https://{Key}@example.com/sentry/12", "example.com", "12", "https://example.com/sentry/api/12/integration/otlp/v1/logs")]
    [InlineData($"  https://{Key}@sentry.example.com/3\n", "sentry.example.com", "3", "https://sentry.example.com/api/3/integration/otlp/v1/logs")]
    [InlineData($"http://{Key}@127.0.0.1:8123/1", "127.0.0.1:8123", "1", "http://127.0.0.1:8123/api/1/integration/otlp/v1/logs")]
    [InlineData($"http://{Key}@localhost/1", "localhost", "1", "http://localhost/api/1/integration/otlp/v1/logs")]
    [InlineData($"http://{Key}@[::1]:9/5", "[::1]:9", "5", "http://[::1]:9/api/5/integration/otlp/v1/logs")]
    public void A_good_dsn_gives_the_destination_and_the_otlp_logs_address(string text, string authority, string projectId, string logsUri)
    {
        Assert.True(SentryDsn.TryParse(text, out var dsn, out var error), error);

        Assert.Equal(authority, dsn!.Authority);
        Assert.Equal(projectId, dsn.ProjectId);
        Assert.Equal(logsUri, dsn.LogsUri.AbsoluteUri);
        Assert.Equal($"sentry sentry_key={Key}", dsn.AuthHeader);
        Assert.Equal(string.Empty, error);
    }

    [Fact]
    public void The_old_secret_part_is_dropped_and_never_sent()
    {
        Assert.True(SentryDsn.TryParse($"https://{Key}:0123456789abcdef@sentry.example.com/9", out var dsn, out _));

        Assert.Equal(Key, dsn!.PublicKey);
        Assert.DoesNotContain("0123456789abcdef", dsn.AuthHeader, StringComparison.Ordinal);
        Assert.DoesNotContain("0123456789abcdef", dsn.LogsUri.AbsoluteUri, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, "Paste the DSN")]
    [InlineData("", "Paste the DSN")]
    [InlineData("   ", "Paste the DSN")]
    [InlineData("not a dsn", "not a Sentry DSN")]
    [InlineData("sentry.example.com/1", "not a Sentry DSN")]
    [InlineData($"ftp://{Key}@sentry.example.com/1", "https")]
    [InlineData($"http://{Key}@sentry.example.com/1", "https")]
    [InlineData($"http://{Key}@192.0.2.10/1", "https")]
    [InlineData("https://sentry.example.com/1", "public key")]
    [InlineData("https://@sentry.example.com/1", "public key")]
    [InlineData("https://bad key!@sentry.example.com/1", "public key")]
    [InlineData($"https://{Key}@/1", "host")]
    [InlineData($"https://{Key}@sentry.example.com", "project")]
    [InlineData($"https://{Key}@sentry.example.com/", "project")]
    [InlineData($"https://{Key}@sentry.example.com/abc", "project")]
    [InlineData($"https://{Key}@sentry.example.com/12/", "project")]
    [InlineData($"https://{Key}@sentry.example.com/12?x=1", "query")]
    [InlineData($"https://{Key}@sentry.example.com/12#frag", "query")]
    [InlineData($"https://{Key}@sentry.example.com:0/12", "port")]
    [InlineData($"https://{Key}@sentry.example.com:70000/12", "port")]
    [InlineData($"https://{Key}@sentry.example.com/a b/12", "path")]
    public void A_bad_dsn_is_refused_with_a_reason_in_plain_words(string? text, string expected)
    {
        Assert.False(SentryDsn.TryParse(text, out var dsn, out var error));

        Assert.Null(dsn);
        Assert.Contains(expected, error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_over_long_dsn_is_refused()
    {
        var text = $"https://{Key}@sentry.example.com/{new string('1', SentryDsn.MaxLength)}";

        Assert.False(SentryDsn.TryParse(text, out _, out var error));
        Assert.Contains("too long", error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Printing_a_dsn_never_shows_the_key()
    {
        Assert.True(SentryDsn.TryParse($"https://{Key}@o1.ingest.sentry.io/4", out var dsn, out _));

        Assert.DoesNotContain(Key, dsn!.ToString(), StringComparison.Ordinal);
        Assert.Contains("o1.ingest.sentry.io", dsn.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Two_dsns_with_the_same_parts_are_equal()
    {
        Assert.True(SentryDsn.TryParse($"https://{Key}@sentry.example.com/1", out var a, out _));
        Assert.True(SentryDsn.TryParse($" https://{Key}@sentry.example.com/1 ", out var b, out _));

        Assert.Equal(a, b);
    }
}
