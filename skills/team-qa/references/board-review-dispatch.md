{{binding}}
Review the locked board with the independent review protocol. Your first tool call must be exactly:
{{packetRead}}
Then follow that packet. Only the two literal reads in this request are allowed. Do not write files, call other tools, delegate, or continue after your final JSON response.
Preserve the exact read call and print its full return object. Do not assign the result to a variable or print only `.output`: the full object contains the exit status needed to authenticate a successful read.
