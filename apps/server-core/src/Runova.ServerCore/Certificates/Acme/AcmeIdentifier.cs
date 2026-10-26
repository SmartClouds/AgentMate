namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// What a certificate is for (RFC 8555 section 9.7.7). Only DNS names are ordered: ASCII, with
/// international names already in punycode, optionally with a leading "*." wildcard label.
/// </summary>
internal sealed record AcmeIdentifier(string Type, string Value)
{
    public const string DnsType = "dns";

    /// <summary>Let's Encrypt's limit on names per certificate.</summary>
    public const int MaxNamesPerOrder = 100;

    private const int MaxNameLength = 253;
    private const int MaxLabelLength = 63;

    public bool IsWildcard => Value.StartsWith("*.", StringComparison.Ordinal);

    /// <summary>Validated, lowercased identifiers without duplicates, in the order given.</summary>
    /// <exception cref="ArgumentException">A name is not a DNS name, or there are none or too many.</exception>
    public static IReadOnlyList<AcmeIdentifier> ForDomains(IEnumerable<string> domains)
    {
        ArgumentNullException.ThrowIfNull(domains);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var identifiers = new List<AcmeIdentifier>();
        foreach (var domain in domains)
        {
            var name = NormalizeDomain(domain);
            if (seen.Add(name))
            {
                identifiers.Add(new AcmeIdentifier(DnsType, name));
            }
        }

        if (identifiers.Count == 0)
        {
            throw new ArgumentException("A certificate needs at least one domain.", nameof(domains));
        }

        if (identifiers.Count > MaxNamesPerOrder)
        {
            throw new ArgumentException($"A certificate can cover at most {MaxNamesPerOrder} domains.", nameof(domains));
        }

        return identifiers;
    }

    /// <summary>The name in lowercase without a trailing dot.</summary>
    /// <exception cref="ArgumentException">The name is not one a certificate can cover.</exception>
    public static string NormalizeDomain(string domain)
    {
        ArgumentNullException.ThrowIfNull(domain);
        var name = domain.EndsWith('.') ? domain[..^1] : domain;
        if (!IsDnsName(name))
        {
            throw new ArgumentException(
                $"\"{AcmeText.Clean(domain, 80)}\" is not a DNS name a certificate can cover.",
                nameof(domain));
        }

        // ASCII only (checked above), so lowercasing cannot change the length or meaning.
        return name.ToLowerInvariant();
    }

    private static bool IsDnsName(string name)
    {
        if (name.Length is 0 or > MaxNameLength)
        {
            return false;
        }

        var labels = name.Split('.');
        var first = labels[0] == "*" ? 1 : 0;

        // At least a registrable-looking name under the wildcard: "localhost" and "*.com" are out.
        if (labels.Length - first < 2)
        {
            return false;
        }

        for (var i = first; i < labels.Length; i++)
        {
            var label = labels[i];
            if (label.Length is 0 or > MaxLabelLength || label[0] == '-' || label[^1] == '-')
            {
                return false;
            }

            foreach (var character in label)
            {
                if (!char.IsAsciiLetterOrDigit(character) && character != '-')
                {
                    return false;
                }
            }
        }

        return true;
    }
}
