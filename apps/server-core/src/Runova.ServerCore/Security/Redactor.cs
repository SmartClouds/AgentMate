using System.Text.Json;
using System.Text.RegularExpressions;

namespace Runova.ServerCore.Security;

/// <summary>
/// Keeps secrets out of everything the core stores or streams: audit parameters, job logs and
/// alert messages. It masks values next to secret-like names, anything shaped like a well-known
/// credential, and the exact values it was seeded with (a stack's env values, a token handed to
/// one job). A pattern that takes too long to match masks the whole text: when in doubt, hide it.
/// </summary>
internal sealed partial class Redactor
{
    public const string Mask = "[redacted]";

    /// <summary>Shorter values ("yes", "1") appear everywhere, so seeding them would mask noise.</summary>
    public const int MinimumSeedLength = 4;

    private const int MatchTimeoutMs = 200;

    /// <summary>Parameter names that carry a secret, matched anywhere in the name.</summary>
    private static readonly string[] _secretNameParts =
    [
        "password", "passwd", "pwd", "passphrase", "secret", "token", "key", "code", "otp", "signature",
        "nonce", "cookie", "credential", "private",
    ];

    /// <summary>Longest first, so a seed that contains another is masked whole.</summary>
    private readonly string[] _seeds;

    public Redactor()
        : this([])
    {
    }

    private Redactor(string[] seeds) => _seeds = seeds;

    /// <summary>A redactor that also masks these exact values; this one is left as it was.</summary>
    public Redactor With(IEnumerable<string?> values)
    {
        ArgumentNullException.ThrowIfNull(values);
        var seeds = _seeds
            .Concat(values
                .Where(value => !string.IsNullOrWhiteSpace(value) && value.Trim().Length >= MinimumSeedLength)
                .Select(value => value!))
            .Distinct(StringComparer.Ordinal)
            .OrderByDescending(value => value.Length)
            .ToArray();
        return new Redactor(seeds);
    }

    public string Redact(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length == 0)
        {
            return text;
        }

        try
        {
            var redacted = text;
            foreach (var seed in _seeds)
            {
                redacted = redacted.Replace(seed, Mask, StringComparison.Ordinal);
            }

            redacted = PrivateKeyBlock().Replace(redacted, Mask);
            redacted = UrlCredentials().Replace(redacted, match => $"{match.Groups["prefix"].Value}{Mask}@");
            redacted = AuthorizationHeader().Replace(redacted, match => $"{match.Groups["prefix"].Value}{Mask}");
            redacted = SecretFlag().Replace(redacted, match => $"{match.Groups["prefix"].Value}{Mask}");
            redacted = SecretAssignment().Replace(redacted, match => $"{match.Groups["prefix"].Value}{Mask}");
            return KnownCredential().Replace(redacted, Mask);
        }
        catch (RegexMatchTimeoutException)
        {
            return Mask;
        }
    }

    /// <summary>
    /// Audit parameters as JSON, sorted by name. A secret-like name hides its value outright; any
    /// other value is redacted like text.
    /// </summary>
    public string? Serialize(IReadOnlyDictionary<string, string?>? parameters)
    {
        if (parameters is null || parameters.Count == 0)
        {
            return null;
        }

        var safe = new SortedDictionary<string, string?>(StringComparer.Ordinal);
        foreach (var (name, value) in parameters)
        {
            safe[name] = IsSecretName(name) ? Mask : value is null ? null : Redact(value);
        }

        return JsonSerializer.Serialize(safe);
    }

    public static bool IsSecretName(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        return _secretNameParts.Any(part => name.Contains(part, StringComparison.OrdinalIgnoreCase));
    }

    internal static bool StartsPrivateKey(string line) => PrivateKeyBegin().IsMatch(line);

    internal static bool EndsPrivateKey(string line) => PrivateKeyEnd().IsMatch(line);

    /// <summary>A PEM private key, or from its first line to the end when the rest is missing.</summary>
    [GeneratedRegex(
        @"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*)",
        RegexOptions.CultureInvariant,
        MatchTimeoutMs)]
    private static partial Regex PrivateKeyBlock();

    [GeneratedRegex(@"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", RegexOptions.CultureInvariant, MatchTimeoutMs)]
    private static partial Regex PrivateKeyBegin();

    [GeneratedRegex(@"-----END [A-Z0-9 ]*PRIVATE KEY-----", RegexOptions.CultureInvariant, MatchTimeoutMs)]
    private static partial Regex PrivateKeyEnd();

    /// <summary>scheme://user:password@host keeps the scheme, the user and the host.</summary>
    [GeneratedRegex(
        @"(?<prefix>\b[a-z][a-z0-9+.\-]*://[^/\s:@]+:)[^/\s@]+@",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase,
        MatchTimeoutMs)]
    private static partial Regex UrlCredentials();

    [GeneratedRegex(
        @"(?<prefix>\b(?:proxy-)?authorization\s*[:=]\s*(?:(?:bearer|basic|token|digest)\s+)?)[^\s'""]+",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase,
        MatchTimeoutMs)]
    private static partial Regex AuthorizationHeader();

    /// <summary>
    /// A command-line flag named like a secret, then its value: `--password x` or `--token=x`.
    /// Flags that read the secret from somewhere else (`--password-stdin`) carry no value.
    /// </summary>
    [GeneratedRegex(
        @"(?<prefix>(?<![\w-])--?[a-z0-9-]*(?:password|passwd|passphrase|secret|token|api-key)(?![a-z0-9-]*-(?:stdin|file)\b)[a-z0-9-]*(?:=|\s+))(?!-)(?:""[^""]*""|'[^']*'|[^\s'""]+)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase,
        MatchTimeoutMs)]
    private static partial Regex SecretFlag();

    /// <summary>`NAME=value`, `name: value` and `"name": "value"` where the name looks like a secret.</summary>
    [GeneratedRegex(
        @"(?<prefix>\b[a-z0-9_.-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[a-z0-9_.-]*[""']?\s*[=:]\s*)(?:""[^""]*""|'[^']*'|[^\s'"",;&]+)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase,
        MatchTimeoutMs)]
    private static partial Regex SecretAssignment();

    /// <summary>Tokens whose shape gives them away, whatever they are called.</summary>
    [GeneratedRegex(
        @"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_\-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}(?:\.[A-Za-z0-9_\-]+)?|xox[abposr]-[A-Za-z0-9\-]{10,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:ant-)?[A-Za-z0-9_\-]{20,}|AIza[0-9A-Za-z_\-]{35}|npm_[A-Za-z0-9]{36}|dckr_pat_[A-Za-z0-9_\-]{20,})",
        RegexOptions.CultureInvariant,
        MatchTimeoutMs)]
    private static partial Regex KnownCredential();
}

/// <summary>
/// Redacts a log one line at a time. A private key spans lines, so once one starts every line is
/// masked until it ends.
/// </summary>
internal sealed class LineRedactor(Redactor redactor)
{
    private bool _inPrivateKey;

    public string Redact(string line)
    {
        ArgumentNullException.ThrowIfNull(line);
        if (_inPrivateKey)
        {
            _inPrivateKey = !Redactor.EndsPrivateKey(line);
            return Redactor.Mask;
        }

        if (Redactor.StartsPrivateKey(line))
        {
            _inPrivateKey = !Redactor.EndsPrivateKey(line);
            return Redactor.Mask;
        }

        return redactor.Redact(line);
    }
}
