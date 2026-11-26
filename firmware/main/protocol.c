#include "protocol.h"

#define FIELD 23
#define DIGITS 3

/* Fixed offset per symbol so that low indices do not produce long runs of one color. */
static const uint8_t OFFSET[MAPPER_CODE_WORDS] = {17, 3, 11, 20, 6, 14, 1, 9, 22, 12, 5, 18, 8, 15};

static void evaluate(unsigned int value, uint8_t *symbols, unsigned int length, const uint8_t *offset)
{
    unsigned int digit[DIGITS];
    for (int i = 0; i < DIGITS; ++i) {
        digit[i] = value % FIELD;
        value /= FIELD;
    }
    for (unsigned int j = 0; j < length; ++j) {
        unsigned int x = j + 1;
        symbols[j] = (uint8_t)((digit[0] + digit[1] * x + digit[2] * x * x + offset[j]) % FIELD);
    }
}

bool mapper_encode(uint16_t index, uint16_t count, uint8_t words[MAPPER_CODE_WORDS])
{
    if (!words || count == 0 || count > MAPPER_MAX_LEDS || index >= count) return false;
    evaluate(index, words, MAPPER_INDEX_SYMBOLS, OFFSET);
    evaluate(count, words + MAPPER_INDEX_SYMBOLS, MAPPER_COUNT_SYMBOLS, OFFSET + MAPPER_INDEX_SYMBOLS);
    return true;
}

uint8_t mapper_frame_symbol(const uint8_t words[MAPPER_CODE_WORDS], unsigned int position)
{
    uint8_t value = words[(position % MAPPER_FRAME_SYMBOLS) / 2];
    return position % 2 == 0 ? value / MAPPER_COLORS : value % MAPPER_COLORS;
}
