using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// Basic auth passwords are stored the way nginx checks them, with the C library's crypt(): SHA-512
/// crypt ($6$), written in-house because no BCL API makes it. The first vectors were checked with
/// <c>openssl passwd -6</c>; the rest come from the scheme's specification by Ulrich Drepper. The
/// nginx harness then logs in through real nginx with a hash made here.
/// </summary>
public sealed class Sha512CryptTests
{
    [Theory]
    [InlineData("Hello world!", "saltstring", 5000, "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1")]
    [InlineData("Hello world!", "saltstringsaltstring", 10000, "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.")]
    [InlineData("This is just a test", "toolongsaltstring", 5000, "$6$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0")]
    [InlineData("a very much longer text to encrypt.  This one even stretches over morethan one line.", "anotherlongsaltstring", 1400, "$6$rounds=1400$anotherlongsalts$POfYwTEok97VWcjxIiSOjiykti.o/pQs.wPvMxQ6Fm7I6IoYN3CmLs66x9t0oSwbtEW7o7UmJEiDwGqd8p4ur1")]
    [InlineData("we have a short salt string but not a short password", "short", 77777, "$6$rounds=77777$short$WuQyW2YR.hBNpjjRhpYD/ifIw05xdfeEyQoMxIXbkvr0gge1a1x3yRULJ5CCaUeOxFmtlcGZelFl5CxtgfiAc0")]
    [InlineData("a short string", "asaltof16chars..", 123456, "$6$rounds=123456$asaltof16chars..$BtCwjqMJGx5hrJhZywWvt0RLE8uZ4oPwcelCjmw2kSYu.Ec6ycULevoBK25fs2xXgMNrCzIMVcgEJAstJeonj1")]
    [InlineData("the minimum number is still observed", "roundstoolow", 10, "$6$rounds=1000$roundstoolow$kUMsbe306n21p9R.FRkW3IGn.S9NPN0x50YhH1xhLsPuWGsUSklZt58jaTfF4ZEQpyUNGc0dqbpBYYBaHHrsX.")]
    public void Known_vectors_hash_exactly(string password, string salt, int rounds, string expected)
    {
        Assert.Equal(expected, Sha512Crypt.Hash(password, salt, rounds));
    }

    [Fact]
    public void A_hash_that_names_the_default_rounds_still_verifies()
    {
        Assert.True(Sha512Crypt.Verify(
            "This is just a test",
            "$6$rounds=5000$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0"));
    }

    [Fact]
    public void New_hashes_use_a_fresh_sixteen_character_salt_and_verify()
    {
        var first = Sha512Crypt.Hash("correct horse battery staple");
        var second = Sha512Crypt.Hash("correct horse battery staple");

        Assert.NotEqual(first, second);
        Assert.Matches("^\\$6\\$[./0-9A-Za-z]{16}\\$[./0-9A-Za-z]{86}$", first);
        Assert.True(Sha512Crypt.IsHash(first));
        Assert.True(Sha512Crypt.Verify("correct horse battery staple", first));
        Assert.False(Sha512Crypt.Verify("correct horse battery stable", first));
    }

    [Fact]
    public void International_and_long_passwords_hash_as_utf8()
    {
        var unicode = Sha512Crypt.Hash("pässwörd ✓", "utf8salt");
        var longer = Sha512Crypt.Hash(new string('x', 200), "longpw");

        Assert.True(Sha512Crypt.Verify("pässwörd ✓", unicode));
        Assert.True(Sha512Crypt.Verify(new string('x', 200), longer));
        Assert.False(Sha512Crypt.Verify(new string('x', 199), longer));
    }

    [Theory]
    [InlineData("$apr1$abcdefgh$0123456789012345678901")]
    [InlineData("{PLAIN}secret")]
    [InlineData("{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")]
    [InlineData("$1$abcdefgh$0123456789012345678901")]
    [InlineData("$5$saltstring$5B8vYYiY.CVt1RlTTf8KbXBH3hsxY/GNooZF1K6vRE8")]
    [InlineData("$6$saltstring$tooshort")]
    [InlineData("$6$salt$string$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1")]
    [InlineData("$6$rounds=999$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1")]
    [InlineData("$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1\n")]
    [InlineData("plain text password")]
    [InlineData("")]
    public void Only_well_formed_sha512_crypt_hashes_count_as_hashes(string text)
    {
        Assert.False(Sha512Crypt.IsHash(text));
        Assert.False(Sha512Crypt.Verify("secret", text));
    }

    [Theory]
    [InlineData("")]
    [InlineData("bad$salt")]
    [InlineData("sält")]
    public void Salts_outside_the_crypt_alphabet_are_refused(string salt)
    {
        Assert.Throws<ArgumentException>(() => Sha512Crypt.Hash("secret", salt));
    }
}
