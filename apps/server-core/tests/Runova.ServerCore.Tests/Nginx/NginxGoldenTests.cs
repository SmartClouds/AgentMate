using System.Text;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// Pins the exact configuration each renderer variant produces. A change to the renderer shows up
/// as a diff against Golden/&lt;variant&gt;.txt; when the change is intended, rerun with
/// RUNOVA_ACCEPT_GOLDEN=1 and review the rewritten files like any other code. A mismatch leaves
/// the new output next to the golden file as &lt;variant&gt;.received.txt.
/// </summary>
public sealed class NginxGoldenTests
{
    public static TheoryData<string> Variants => [.. NginxVariants.Names];

    [Theory]
    [MemberData(nameof(Variants))]
    public void Each_variant_renders_exactly_its_golden_file(string variant)
    {
        var layout = NginxVariants.Layout(variant, NginxLayout.Debian);
        var release = NginxRenderer.Render(NginxVariants.Get(variant), layout, UpstreamPolicy.Default, release: 1);

        GoldenFiles.AssertMatches(variant, Format(release));
    }

    [Fact]
    public void Every_variant_has_a_golden_file_and_every_golden_file_a_variant()
    {
        var files = Directory.GetFiles(GoldenFiles.OutputFolder, "*.txt")
            .Select(Path.GetFileNameWithoutExtension)
            .Where(name => !name!.EndsWith(".received", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal);

        Assert.Equal(NginxVariants.Names.Order(StringComparer.Ordinal), files);
    }

    /// <summary>All files of a release in one text, each under a header line naming it.</summary>
    private static string Format(NginxRelease release)
    {
        var text = new StringBuilder();
        foreach (var file in release.Files)
        {
            if (text.Length > 0)
            {
                text.Append('\n');
            }

            text.Append("==> ").Append(file.Path).Append(" <==\n").Append(file.Content);
        }

        return text.ToString();
    }
}

/// <summary>Golden files are copied next to the test binary; accepted or received output goes back to the source folder.</summary>
internal static class GoldenFiles
{
    public static string OutputFolder => Path.Combine(AppContext.BaseDirectory, "Nginx", "Golden");

    public static void AssertMatches(string name, string actual)
    {
        var path = Path.Combine(OutputFolder, name + ".txt");
        var expected = File.Exists(path) ? File.ReadAllText(path).ReplaceLineEndings("\n") : null;
        if (expected == actual)
        {
            return;
        }

        var sourceFolder = SourceFolder();
        if (Environment.GetEnvironmentVariable("RUNOVA_ACCEPT_GOLDEN") == "1")
        {
            File.WriteAllText(Path.Combine(sourceFolder, name + ".txt"), actual);
            return;
        }

        var received = Path.Combine(sourceFolder, name + ".received.txt");
        File.WriteAllText(received, actual);
        Assert.Fail(expected is null
            ? $"There is no golden file for '{name}' yet. Review {received} and rerun with RUNOVA_ACCEPT_GOLDEN=1 to keep it."
            : $"'{name}' no longer renders its golden file. Compare {received} with {name}.txt.");
    }

    /// <summary>The test project's Nginx/Golden folder, found by walking up from the binary.</summary>
    private static string SourceFolder()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Runova.ServerCore.Tests.csproj")))
            {
                var folder = Path.Combine(directory.FullName, "Nginx", "Golden");
                Directory.CreateDirectory(folder);
                return folder;
            }
        }

        throw new InvalidOperationException("The test project's folder was not found above " + AppContext.BaseDirectory);
    }
}
