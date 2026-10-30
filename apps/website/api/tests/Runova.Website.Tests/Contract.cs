namespace Runova.Website.Tests;

/// <summary>docs/website/api-contract.md, found above the test binary, for tests that check the code against it.</summary>
internal static class Contract
{
    public static string Read() => File.ReadAllText(Find());

    private static string Find()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "docs", "website", "api-contract.md");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException("docs/website/api-contract.md was not found above the test binary.");
    }
}
