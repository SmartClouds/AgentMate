namespace Runova.Website.Api.Http;

/// <summary>The public site's origin, which links in emails and item URLs point at.</summary>
internal static class SiteUrl
{
    private const string Default = "https://runovahq.com";

    /// <summary><c>Website:SiteUrl</c>, or the production site, with no trailing slash.</summary>
    public static string From(IConfiguration configuration) => (configuration["Website:SiteUrl"] ?? Default).TrimEnd('/');
}
