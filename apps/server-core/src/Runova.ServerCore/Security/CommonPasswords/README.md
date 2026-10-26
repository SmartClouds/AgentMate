# Common passwords

`common-passwords.txt` is how the core refuses passwords that are long enough but still easy to
guess. It comes from SecLists (MIT license, see `LICENSE`):
`Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`, keeping only entries of
12 to 64 characters (shorter ones already fail the length rule), lowercased, without duplicates,
sorted. The core compares a candidate password in lower case, so capitalizing a listed password
does not get it through.
