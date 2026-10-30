using System.Text;
using Runova.Website.Core.Identity;

namespace Runova.Website.Tests.Identity;

public class Base32Tests
{
    [Theory]
    [InlineData("", "")]
    [InlineData("f", "MY")]
    [InlineData("fo", "MZXQ")]
    [InlineData("foo", "MZXW6")]
    [InlineData("foob", "MZXW6YQ")]
    [InlineData("fooba", "MZXW6YTB")]
    [InlineData("foobar", "MZXW6YTBOI")]
    public void Decode_matches_the_rfc_4648_vectors(string expected, string encoded)
    {
        Assert.Equal(expected, Encoding.ASCII.GetString(Base32.Decode(encoded)));
    }

    [Fact]
    public void Decode_ignores_case_spaces_and_padding()
    {
        Assert.Equal("foobar", Encoding.ASCII.GetString(Base32.Decode("mzxw 6ytb oi======")));
    }

    [Fact]
    public void Decode_refuses_a_letter_outside_the_alphabet()
    {
        Assert.Throws<FormatException>(() => Base32.Decode("MZXW1"));
    }
}
