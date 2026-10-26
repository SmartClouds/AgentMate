using System.Globalization;
using System.Text;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// Host and domain names as nginx and the system resolver see them. Only ASCII letter-digit-hyphen
/// labels pass: international names arrive in their xn-- form (the core runs without ICU), and
/// anything else could be read differently by different parsers.
/// </summary>
internal static class NginxNames
{
    public const int MaxLength = 253;
    public const int MaxLabelLength = 63;

    /// <summary>Why this is not a usable host name, or null when it is one. Expects lowercase.</summary>
    public static string? HostNameProblem(string name)
    {
        if (name.Length == 0)
        {
            return "The host name is empty.";
        }

        if (name.Length > MaxLength)
        {
            return $"'{Show(name)}' is longer than {MaxLength} characters, the most DNS allows.";
        }

        var labels = name.Split('.');
        if (IsNumericShorthand(labels))
        {
            return $"'{Show(name)}' is a numeric shorthand the system resolver would read as an IPv4 address; write the address as four decimal numbers without leading zeros, like 10.0.0.5.";
        }

        foreach (var label in labels)
        {
            if (label.Length is 0 or > MaxLabelLength
                || label[0] == '-'
                || label[^1] == '-'
                || !label.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-'))
            {
                return $"'{Show(name)}' is not a valid host name: each part between dots must be 1 to {MaxLabelLength} letters, digits or hyphens, not starting or ending with a hyphen.";
            }
        }

        if (labels.Length > 1 && labels[^1].All(char.IsAsciiDigit))
        {
            return $"'{Show(name)}' is not a valid host name: a top-level domain is never all digits.";
        }

        return null;
    }

    /// <summary>
    /// Why this cannot be one of a site's domains, or null when it can. Any case is accepted (sites
    /// render the lowercase form); a leading <c>*.</c> makes a wildcard.
    /// </summary>
    public static string? DomainProblem(string domain)
    {
        if (domain.Length == 0)
        {
            return "The domain is empty.";
        }

        if (domain.Any(c => c > '~'))
        {
            return $"'{Show(domain)}' has characters outside ASCII; international domains are sent in their xn-- form.";
        }

        var name = domain.ToLowerInvariant();
        if (name.EndsWith('.'))
        {
            return $"Write '{Show(domain)}' without the trailing dot.";
        }

        var wildcard = name.StartsWith("*.", StringComparison.Ordinal);
        var rest = wildcard ? name[2..] : name;
        if (NginxAddresses.TryParse(rest, out _) || rest.Contains(':', StringComparison.Ordinal))
        {
            return $"'{Show(domain)}' is an IP address; sites answer for domain names, and requests by address get no answer.";
        }

        if (HostNameProblem(rest) is { } problem)
        {
            return problem;
        }

        if (!rest.Contains('.', StringComparison.Ordinal))
        {
            return wildcard
                ? "A wildcard needs a domain with a dot after *., like *.example.com."
                : $"'{Show(domain)}' needs a dot, like example.com; a single-label name cannot get a certificate.";
        }

        return null;
    }

    /// <summary>A user's value made safe to repeat in a message: control characters escaped, long values cut.</summary>
    public static string Show(string text)
    {
        var shown = new StringBuilder();
        foreach (var c in text.Length <= 60 ? text : text[..60])
        {
            if (char.IsControl(c) || char.GetUnicodeCategory(c) is UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
            {
                shown.Append(CultureInfo.InvariantCulture, $"\\u{(int)c:X4}");
            }
            else
            {
                shown.Append(c);
            }
        }

        return text.Length <= 60 ? shown.ToString() : shown + "...";
    }

    /// <summary>
    /// The C library's <c>inet_aton</c>, which nginx falls back to through <c>getaddrinfo</c>,
    /// reads one to four dot-separated decimal, octal (leading 0) or hex (0x) numbers as an IPv4
    /// address, so <c>2852039166</c> or <c>0xa9.0xfe.0xa9.0xfe</c> would reach 169.254.169.254.
    /// </summary>
    private static bool IsNumericShorthand(string[] labels) =>
        labels.Length <= 4
        && labels.All(label =>
            (label.Length > 0 && label.All(char.IsAsciiDigit))
            || (label.StartsWith("0x", StringComparison.Ordinal) && label[2..].All(char.IsAsciiHexDigit)));
}
