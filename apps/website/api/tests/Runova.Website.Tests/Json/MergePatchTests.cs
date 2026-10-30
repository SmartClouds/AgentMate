using System.Text.Json.Nodes;
using Runova.Website.Core.Json;

namespace Runova.Website.Tests.Json;

public class MergePatchTests
{
    // The examples of RFC 7396, appendix A.
    [Theory]
    [InlineData("""{"a":"b"}""", """{"a":"c"}""", """{"a":"c"}""")]
    [InlineData("""{"a":"b"}""", """{"b":"c"}""", """{"a":"b","b":"c"}""")]
    [InlineData("""{"a":"b"}""", """{"a":null}""", """{}""")]
    [InlineData("""{"a":"b","b":"c"}""", """{"a":null}""", """{"b":"c"}""")]
    [InlineData("""{"a":["b"]}""", """{"a":"c"}""", """{"a":"c"}""")]
    [InlineData("""{"a":"c"}""", """{"a":["b"]}""", """{"a":["b"]}""")]
    [InlineData("""{"a":{"b":"c"}}""", """{"a":{"b":"d","c":null}}""", """{"a":{"b":"d"}}""")]
    [InlineData("""{"a":[{"b":"c"}]}""", """{"a":[1]}""", """{"a":[1]}""")]
    [InlineData("""["a","b"]""", """["c","d"]""", """["c","d"]""")]
    [InlineData("""{"a":"b"}""", """["c"]""", """["c"]""")]
    [InlineData("""{"a":"foo"}""", "null", "null")]
    [InlineData("""{"a":"foo"}""", "\"bar\"", "\"bar\"")]
    [InlineData("""{"e":null}""", """{"a":1}""", """{"e":null,"a":1}""")]
    [InlineData("""[1,2]""", """{"a":"b","c":null}""", """{"a":"b"}""")]
    [InlineData("""{}""", """{"a":{"bb":{"ccc":null}}}""", """{"a":{"bb":{}}}""")]
    public void It_follows_the_rfc_examples(string target, string patch, string expected)
    {
        var result = MergePatch.Apply(JsonNode.Parse(target), JsonNode.Parse(patch));

        Assert.Equal(expected, result?.ToJsonString() ?? "null");
    }

    [Fact]
    public void It_leaves_the_target_and_the_patch_unchanged()
    {
        var target = JsonNode.Parse("""{"a":{"b":"c"},"d":[1]}""");
        var patch = JsonNode.Parse("""{"a":{"b":"x"},"d":[2]}""");

        MergePatch.Apply(target, patch);

        Assert.Equal("""{"a":{"b":"c"},"d":[1]}""", target!.ToJsonString());
        Assert.Equal("""{"a":{"b":"x"},"d":[2]}""", patch!.ToJsonString());
    }
}
