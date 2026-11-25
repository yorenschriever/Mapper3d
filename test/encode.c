#include <stdio.h>
#include <stdlib.h>
#include "protocol.h"

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    int index = atoi(argv[1]);
    int count = atoi(argv[2]);
    uint8_t words[MAPPER_CODE_WORDS];
    if (index < 0 || count < 0 || !mapper_encode(index, count, words)) return 3;
    for (unsigned int i = 0; i < MAPPER_FRAME_SYMBOLS; ++i)
        printf("%u%s", mapper_frame_symbol(words, i), i + 1 == MAPPER_FRAME_SYMBOLS ? "\n" : " ");
    return 0;
}
